import * as vscode from 'vscode';
import * as path from 'path';

export interface DocumentChunk {
    pageContent: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
}

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

export function chunkFile(content: string, filePath: string, extension: string): DocumentChunk[] {
    const lines = content.split(/\r?\n/);
    const chunks: DocumentChunk[] = [];
    const chunkSize = 1500;
    const chunkOverlap = 200;
    
    let currentChunkLines: string[] = [];
    let currentLength = 0;
    let startLine = 1;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        currentChunkLines.push(line);
        currentLength += line.length + 1;
        
        if (currentLength >= chunkSize || i === lines.length - 1) {
            const endLine = i + 1;
            chunks.push({
                pageContent: currentChunkLines.join("\n"),
                filePath,
                startLine,
                endLine,
                language: extension.slice(1)
            });
            
            // Sliding overlap
            const overlapCharLimit = chunkOverlap;
            let overlapLines: string[] = [];
            let overlapLen = 0;
            
            for (let j = currentChunkLines.length - 1; j >= 0; j--) {
                const oLine = currentChunkLines[j];
                if (overlapLen + oLine.length > overlapCharLimit) {
                    break;
                }
                overlapLines.unshift(oLine);
                overlapLen += oLine.length + 1;
            }
            
            currentChunkLines = overlapLines;
            currentLength = overlapLen;
            startLine = Math.max(1, endLine - overlapLines.length + 1);
        }
    }
    
    return chunks;
}

export async function scanWorkspace(progressCallback: (msg: string) => void): Promise<DocumentChunk[]> {
    const allChunks: DocumentChunk[] = [];
    
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        throw new Error("No active workspace open.");
    }
    
    // Find all files
    progressCallback("Scanning workspace files...");
    const files = await vscode.workspace.findFiles("**/*", "**/node_modules/**");
    
    const filteredFiles = files.filter(uri => {
        const ext = path.extname(uri.fsPath).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) {
            return false;
        }
        // Check ignore patterns
        const relPath = vscode.workspace.asRelativePath(uri);
        return !IGNORE_PATTERNS.some(pat => relPath.includes(pat));
    });
    
    const totalFiles = filteredFiles.length;
    progressCallback(`Found ${totalFiles} target files to index.`);
    
    for (let i = 0; i < totalFiles; i++) {
        const uri = filteredFiles[i];
        const relPath = vscode.workspace.asRelativePath(uri);
        const ext = path.extname(uri.fsPath).toLowerCase();
        
        progressCallback(`Processing file (${i + 1}/${totalFiles}): ${relPath}`);
        
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const content = doc.getText();
            if (content.trim().length === 0) {
                continue;
            }
            const fileChunks = chunkFile(content, relPath, ext);
            allChunks.push(...fileChunks);
        } catch (e: any) {
            console.error(`Error loading file: ${relPath}`, e);
        }
    }
    
    return allChunks;
}
