import * as vscode from 'vscode';
import { DocumentChunk, chunkFile } from './indexer';
import * as path from 'path';

const ALLOWED_EXTENSIONS = new Set([
    ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".go", ".cpp", ".c", 
    ".rb", ".rs", ".cs", ".php", ".html", ".css", ".md", ".json", 
    ".txt", ".yaml", ".yml", ".toml", ".sh", ".ini"
]);

const IGNORE_PATTERNS = [
    "node_modules",
    ".git",
    "__pycache__",
    "venv",
    ".venv",
    "dist",
    "build",
    ".next",
    "out",
    ".vscode-test"
];

async function fetchWithAuth(url: string, token: string): Promise<any> {
    const headers: Record<string, string> = {
        "User-Agent": "vscode-codebase-qa-extension"
    };
    if (token) {
        headers["Authorization"] = `token ${token}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`GitHub API error (${res.status}): ${errText}`);
    }
    return res.json();
}

async function fetchFileContent(owner: string, repo: string, branch: string, filePath: string, token: string): Promise<string> {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
    const headers: Record<string, string> = {
        "User-Agent": "vscode-codebase-qa-extension"
    };
    if (token) {
        headers["Authorization"] = `token ${token}`;
    }

    let response = await fetch(rawUrl, { headers });
    if (!response.ok && token) {
        // Fallback to official API endpoint for private repos (supports subdirectories better)
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${branch}`;
        const apiHeaders: Record<string, string> = {
            "User-Agent": "vscode-codebase-qa-extension",
            "Authorization": `token ${token}`,
            "Accept": "application/vnd.github.v3.raw"
        };
        response = await fetch(apiUrl, { headers: apiHeaders });
    }

    if (!response.ok) {
        throw new Error(`Failed to download ${filePath} (${response.status})`);
    }
    return response.text();
}

export async function indexGithubRepo(
    repoPath: string,
    branchName: string,
    githubToken: string,
    progressCallback: (msg: string) => void
): Promise<DocumentChunk[]> {
    let cleanPath = repoPath.replace(/https:\/\/github.com\//, '').replace(/\.git$/, '');
    const parts = cleanPath.split('/');
    if (parts.length < 2) {
        throw new Error("Invalid repository path. Format should be 'owner/repo'.");
    }
    const owner = parts[0];
    const repo = parts[1];

    progressCallback(`Connecting to GitHub for repository ${owner}/${repo}...`);

    let branch = branchName.trim();
    if (!branch) {
        // Fetch default branch
        const repoInfo = await fetchWithAuth(`https://api.github.com/repos/${owner}/${repo}`, githubToken);
        branch = repoInfo.default_branch || 'main';
    }

    progressCallback(`Fetching file tree for branch: ${branch}...`);
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    const treeData = await fetchWithAuth(treeUrl, githubToken);

    if (!treeData.tree || !Array.isArray(treeData.tree)) {
        throw new Error("Failed to retrieve repository tree structure.");
    }

    const filteredFiles = treeData.tree.filter((item: any) => {
        if (item.type !== 'blob') { return false; }
        const ext = path.extname(item.path).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) { return false; }
        // Check size limit (skip files > 500KB)
        if (item.size && item.size > 500 * 1024) { return false; }
        // Check ignore patterns
        return !IGNORE_PATTERNS.some(pat => item.path.includes(pat));
    });

    const totalFiles = filteredFiles.length;
    progressCallback(`Found ${totalFiles} target files in remote repository.`);

    const allChunks: DocumentChunk[] = [];
    const batchSize = 5; // Download 5 files concurrently to avoid rate limit or connection issues

    for (let i = 0; i < totalFiles; i += batchSize) {
        const batch = filteredFiles.slice(i, i + batchSize);
        progressCallback(`Downloading files (${i}/${totalFiles} completed)...`);

        await Promise.all(batch.map(async (file: any) => {
            try {
                const content = await fetchFileContent(owner, repo, branch, file.path, githubToken);
                if (content.trim().length === 0) { return; }

                const ext = path.extname(file.path).toLowerCase();
                const fileChunks = chunkFile(content, file.path, ext);

                // Re-write filePath so the references point to github
                fileChunks.forEach(c => {
                    c.filePath = `github:${owner}/${repo}/${branch}/${file.path}`;
                });

                allChunks.push(...fileChunks);
            } catch (err: any) {
                console.error(`Failed to download file ${file.path}: ${err.message}`);
            }
        }));
    }

    return allChunks;
}
