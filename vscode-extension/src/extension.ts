import * as vscode from 'vscode';
import { LocalVectorStore } from './vectorStore';
import { LLMClientManager } from './llm';
import { ChatViewProvider } from './chatViewProvider';

async function loadAllKeys(context: vscode.ExtensionContext): Promise<Record<string, string>> {
    const keys: Record<string, string> = {};
    keys['groq_api_key'] = await context.secrets.get('groq_api_key') || "";
    keys['openai_api_key'] = await context.secrets.get('openai_api_key') || "";
    keys['anthropic_api_key'] = await context.secrets.get('anthropic_api_key') || "";
    keys['gemini_api_key'] = await context.secrets.get('gemini_api_key') || "";
    keys['github_token'] = await context.secrets.get('github_token') || "";
    return keys;
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('Codebase Q&A Extension is now active!');

    // Initialize Vector Store and LLM Client Manager
    const vectorStore = new LocalVectorStore(context.globalStorageUri.fsPath);
    const llmClient = new LLMClientManager();

    // Load API Keys from SecretStorage
    const allKeys = await loadAllKeys(context);
    llmClient.setKeys(allKeys);

    const hfToken = await context.secrets.get('hf_token') || "";
    vectorStore.setKeys(hfToken);

    // Register sidebar chat provider
    const provider = new ChatViewProvider(
        context.extensionUri,
        vectorStore,
        llmClient,
        context
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)
    );

    // Command to configure API keys
    context.subscriptions.push(
        vscode.commands.registerCommand('codebase-qa.setKeys', async () => {
            const config = vscode.workspace.getConfiguration('codebase-qa');
            const activeProvider = config.get<string>('provider') || 'groq';

            // 1. Prompt for currently selected provider key
            if (activeProvider !== 'ollama') {
                const secretKeyMap: Record<string, string> = {
                    'groq': 'groq_api_key',
                    'openai': 'openai_api_key',
                    'anthropic': 'anthropic_api_key',
                    'gemini': 'gemini_api_key'
                };
                const secretKey = secretKeyMap[activeProvider];
                const displayNameMap: Record<string, string> = {
                    'groq': 'Groq API Key',
                    'openai': 'OpenAI API Key',
                    'anthropic': 'Anthropic API Key',
                    'gemini': 'Gemini API Key'
                };
                const currentKey = await context.secrets.get(secretKey) || "";
                
                const keyInput = await vscode.window.showInputBox({
                    prompt: `Enter your ${displayNameMap[activeProvider]}:`,
                    value: currentKey,
                    password: true,
                    ignoreFocusOut: true
                });

                if (keyInput !== undefined) {
                    await context.secrets.store(secretKey, keyInput.trim());
                    // Update key in manager
                    const updatedKeys = await loadAllKeys(context);
                    llmClient.setKeys(updatedKeys);
                }
            } else {
                vscode.window.showInformationMessage("Ollama does not require an API Key.");
            }

            // 2. Prompt for Hugging Face Token (for local embeddings)
            const currentHfToken = await context.secrets.get('hf_token') || "";
            const hfTokenInput = await vscode.window.showInputBox({
                prompt: "Enter your Hugging Face API Token (optional, used for higher embedding rate limits):",
                value: currentHfToken,
                password: true,
                ignoreFocusOut: true
            });

            if (hfTokenInput !== undefined) {
                await context.secrets.store('hf_token', hfTokenInput.trim());
                vectorStore.setKeys(hfTokenInput.trim());
            }

            // 3. Prompt for GitHub Token (optional, for indexing private/large repos)
            const currentGithubToken = await context.secrets.get('github_token') || "";
            const githubTokenInput = await vscode.window.showInputBox({
                prompt: "Enter your GitHub Personal Access Token (optional, for private/higher rate limit repo indexing):",
                value: currentGithubToken,
                password: true,
                ignoreFocusOut: true
            });

            if (githubTokenInput !== undefined) {
                await context.secrets.store('github_token', githubTokenInput.trim());
            }

            vscode.window.showInformationMessage("Codebase Q&A secrets updated successfully!");
        })
    );

    // Command to clear index
    context.subscriptions.push(
        vscode.commands.registerCommand('codebase-qa.clearIndex', async () => {
            vectorStore.clear();
            vscode.window.showInformationMessage("Workspace vector index cleared successfully!");
            // Refresh view
            await vscode.commands.executeCommand('workbench.action.webview.reloadActiveWebview');
        })
    );

    // Command to index remote GitHub repository
    context.subscriptions.push(
        vscode.commands.registerCommand('codebase-qa.indexGithubRepo', async () => {
            await provider.handleGithubIndexing();
        })
    );

    // Command to clear chat history
    context.subscriptions.push(
        vscode.commands.registerCommand('codebase-qa.clearChat', () => {
            provider.clearChatHistory();
            vscode.window.showInformationMessage("Chat history cleared!");
        })
    );

    // Prompt user to configure keys if active key is missing on startup
    const config = vscode.workspace.getConfiguration('codebase-qa');
    const activeProvider = config.get<string>('provider') || 'groq';
    if (activeProvider !== 'ollama') {
        const secretKeyMap: Record<string, string> = {
            'groq': 'groq_api_key',
            'openai': 'openai_api_key',
            'anthropic': 'anthropic_api_key',
            'gemini': 'gemini_api_key'
        };
        const activeKey = await context.secrets.get(secretKeyMap[activeProvider]) || "";
        if (!activeKey) {
            const setKeysOption = "Configure API Keys";
            vscode.window.showWarningMessage(
                `Codebase Q&A: Please configure your API key for '${activeProvider}' to start chatting about your codebase.`,
                setKeysOption
            ).then(selection => {
                if (selection === setKeysOption) {
                    vscode.commands.executeCommand('codebase-qa.setKeys');
                }
            });
        }
    }
}

export function deactivate() {
    console.log('Codebase Q&A Extension deactivated.');
}
