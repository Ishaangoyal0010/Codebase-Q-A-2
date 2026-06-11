import * as vscode from 'vscode';
import { LocalVectorStore } from './vectorStore';
import { GroqClient } from './llm';
import { ChatViewProvider } from './chatViewProvider';

export async function activate(context: vscode.ExtensionContext) {
    console.log('Codebase Q&A Extension is now active!');

    // Initialize Vector Store and Groq client
    const vectorStore = new LocalVectorStore(context.globalStorageUri.fsPath);
    const groqClient = new GroqClient();

    // Load API Keys from SecretStorage
    const groqApiKey = await context.secrets.get('groq_api_key') || "";
    const hfToken = await context.secrets.get('hf_token') || "";

    vectorStore.setKeys(hfToken);
    groqClient.setKeys(groqApiKey);

    // Register sidebar chat provider
    const provider = new ChatViewProvider(
        context.extensionUri,
        vectorStore,
        groqClient,
        context
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)
    );

    // Command to configure API keys
    context.subscriptions.push(
        vscode.commands.registerCommand('codebase-qa.setKeys', async () => {
            const currentGroqKey = await context.secrets.get('groq_api_key') || "";
            const currentHfToken = await context.secrets.get('hf_token') || "";

            const groqKeyInput = await vscode.window.showInputBox({
                prompt: "Enter your Groq API Key:",
                value: currentGroqKey,
                password: true,
                ignoreFocusOut: true
            });

            if (groqKeyInput !== undefined) {
                await context.secrets.store('groq_api_key', groqKeyInput.trim());
                groqClient.setKeys(groqKeyInput.trim());
            }

            const hfTokenInput = await vscode.window.showInputBox({
                prompt: "Enter your Hugging Face API Token (optional, used for higher rate limits):",
                value: currentHfToken,
                password: true,
                ignoreFocusOut: true
            });

            if (hfTokenInput !== undefined) {
                await context.secrets.store('hf_token', hfTokenInput.trim());
                vectorStore.setKeys(hfTokenInput.trim());
            }

            vscode.window.showInformationMessage("Codebase Q&A API Keys updated successfully!");
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

    // Prompt user to configure keys if Groq key is missing on startup
    if (!groqApiKey) {
        const setKeysOption = "Configure API Keys";
        vscode.window.showWarningMessage(
            "Codebase Q&A: Please configure your Groq API Key to start chatting about your codebase.",
            setKeysOption
        ).then(selection => {
            if (selection === setKeysOption) {
                vscode.commands.executeCommand('codebase-qa.setKeys');
            }
        });
    }
}

export function deactivate() {
    console.log('Codebase Q&A Extension deactivated.');
}
