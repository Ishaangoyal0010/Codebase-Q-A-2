import * as vscode from 'vscode';
import { LocalVectorStore } from './vectorStore';
import { GroqClient } from './llm';
import { scanWorkspace } from './indexer';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'codebase-qa.chatView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _vectorStore: LocalVectorStore,
        private readonly _groqClient: GroqClient,
        private readonly _context: vscode.ExtensionContext
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Send initial state
        this._updateIndexedCount();

        // Listen for messages from the Webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'askQuestion':
                    await this._handleQuestion(data.question);
                    break;
                case 'indexWorkspace':
                    await this._handleIndexing();
                    break;
                case 'openFile':
                    await this._handleOpenFile(data.file, data.line);
                    break;
                case 'configureKeys':
                    await vscode.commands.executeCommand('codebase-qa.setKeys');
                    break;
            }
        });
    }

    private _updateIndexedCount() {
        if (this._view) {
            const count = this._vectorStore.getChunkCount();
            this._view.webview.postMessage({
                type: 'updateIndexedCount',
                count
            });
        }
    }

    private async _handleIndexing() {
        if (!this._view) { return; }

        this._view.webview.postMessage({ type: 'indexingProgress', message: "Initializing workspace..." });

        try {
            const chunks = await scanWorkspace((msg) => {
                if (this._view) {
                    this._view.webview.postMessage({ type: 'indexingProgress', message: msg });
                }
            });

            if (chunks.length === 0) {
                throw new Error("No readable source files found in the current workspace.");
            }

            await this._vectorStore.indexChunks(chunks, (msg) => {
                if (this._view) {
                    this._view.webview.postMessage({ type: 'indexingProgress', message: msg });
                }
            });

            this._updateIndexedCount();
            this._view.webview.postMessage({ type: 'indexingComplete', count: chunks.length });
        } catch (e: any) {
            this._view.webview.postMessage({ type: 'indexingError', error: e.message });
            vscode.window.showErrorMessage(`Workspace indexing failed: ${e.message}`);
        }
    }

    private async _handleOpenFile(filePath: string, line: number) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return; }

        try {
            const uri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);
            
            // Highlight and center target line
            const pos = new vscode.Position(Math.max(0, line - 1), 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Could not open file ${filePath}: ${e.message}`);
        }
    }

    private async _handleQuestion(question: string) {
        if (!this._view) { return; }

        // 1. check pleasantries locally (prevent RAG / LLM calls)
        const specialReply = this._handleSpecial(question);
        if (specialReply) {
            if (specialReply === "NO_REPLY") {
                this._view.webview.postMessage({
                    type: 'answerReceived',
                    answer: "",
                    sources: [],
                    silent: true
                });
            } else {
                this._view.webview.postMessage({
                    type: 'answerReceived',
                    answer: specialReply,
                    sources: []
                });
            }
            return;
        }

        // 2. Perform search
        try {
            const indexedCount = this._vectorStore.getChunkCount();
            if (indexedCount === 0) {
                throw new Error("Workspace is not indexed yet. Please click the 'Index Workspace' button first!");
            }

            this._view.webview.postMessage({ type: 'searching' });
            
            const results = await this._vectorStore.search(question, 6);
            if (results.length === 0) {
                this._view.webview.postMessage({
                    type: 'answerReceived',
                    answer: "No relevant code segments could be found in the current index.",
                    sources: []
                });
                return;
            }

            const answer = await this._groqClient.ask(question, results);
            
            const sources = results.map(r => ({
                reference: `${r.chunk.filePath}:${r.chunk.startLine}-${r.chunk.endLine}`,
                file: r.chunk.filePath,
                line: r.chunk.startLine,
                similarity: Math.round(r.similarity * 10000) / 10000
            }));

            this._view.webview.postMessage({
                type: 'answerReceived',
                answer,
                sources
            });
        } catch (e: any) {
            this._view.webview.postMessage({
                type: 'answerError',
                error: e.message
            });
        }
    }

    private _handleSpecial(question: string): string | null {
        const q = question.toLowerCase().trim();
        
        const THANKS_KEYWORDS = ["thank you", "thanks", "thx", "ty", "tanks", "thank u", "thankyou", "tq"];
        if (THANKS_KEYWORDS.some(tk => q.includes(tk))) {
            return "You're welcome! 😊 Let me know if you need help with anything else in the codebase.";
        }
        
        const OK_KEYWORDS = new Set(["ok", "okay", "okk", "okey", "got it", "fine", "cool", "sure", "nice", "kk", "k"]);
        const words = new Set(q.replace(/[.,!?]/g, "").split(/\s+/));
        
        let hasOk = false;
        for (const w of words) {
            if (OK_KEYWORDS.has(w)) {
                hasOk = true;
                break;
            }
        }
        if (hasOk || OK_KEYWORDS.has(q)) {
            return "NO_REPLY";
        }
        
        const GREETINGS = [
            "hello", "hi", "hey", "hii", "helo", "sup", "yo", "namaste",
            "good morning", "good evening", "good afternoon", "good night",
            "how are you", "how r you", "how are u", "what's up", "whats up"
        ];
        if (GREETINGS.some(g => q === g || q.startsWith(g))) {
            return "Hello! 👋 How can I help you? Ask any question about your codebase and I'll find the relevant files.";
        }
        
        return null;
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Codebase Q&A Chat</title>
    <style>
        body {
            padding: 10px;
            font-family: var(--vscode-font-family, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            display: flex;
            flex-direction: column;
            height: 100vh;
            box-sizing: border-box;
            margin: 0;
        }

        #indexer-status {
            padding: 8px;
            background: var(--vscode-welcomePage-tileBackground, #252526);
            border-radius: 4px;
            margin-bottom: 10px;
            border: 1px solid var(--vscode-widget-border, #3c3c3c);
        }

        .status-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-weight: bold;
            margin-bottom: 6px;
        }

        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 2px;
            cursor: pointer;
            width: 100%;
            font-weight: bold;
        }

        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        #chat-container {
            flex-grow: 1;
            overflow-y: auto;
            margin-bottom: 60px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding-right: 4px;
        }

        .message {
            max-width: 90%;
            padding: 8px 12px;
            border-radius: 6px;
            line-height: 1.4;
            word-wrap: break-word;
            display: inline-block;
        }

        .message.user {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            align-self: flex-end;
        }

        .message.assistant {
            background-color: var(--vscode-editor-inactiveSelectionBackground, #2d2d30);
            color: var(--vscode-foreground);
            align-self: flex-start;
            border: 1px solid var(--vscode-widget-border, #3c3c3c);
        }

        .sources-container {
            margin-top: 6px;
            font-size: 11px;
            border-top: 1px dashed var(--vscode-widget-border);
            padding-top: 4px;
        }

        .source-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            display: block;
            cursor: pointer;
            margin-top: 2px;
        }

        .source-link:hover {
            text-decoration: underline;
        }

        #input-container {
            position: fixed;
            bottom: 10px;
            left: 10px;
            right: 10px;
            display: flex;
            gap: 6px;
            background-color: var(--vscode-sideBar-background);
        }

        #chat-input {
            flex-grow: 1;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            padding: 6px;
            border-radius: 2px;
            outline: none;
        }

        #chat-input:focus {
            border-color: var(--vscode-focusBorder);
        }

        .spinner {
            display: inline-block;
            width: 12px;
            height: 12px;
            border: 2px solid rgba(255,255,255,.3);
            border-radius: 50%;
            border-top-color: var(--vscode-foreground);
            animation: spin 1s ease-in-out infinite;
            margin-right: 6px;
        }

        #progress-log {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            max-height: 40px;
            overflow-y: auto;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div id="indexer-status">
        <div class="status-header">
            <span>Workspace Index</span>
            <span id="chunks-count">0 chunks</span>
        </div>
        <button id="index-btn" class="btn-primary">Index Workspace</button>
        <div id="progress-log"></div>
    </div>

    <div id="chat-container">
        <div class="message assistant">
            Hi! 👋 Index your workspace first, then ask me anything about the code.
        </div>
    </div>

    <div id="input-container">
        <input type="text" id="chat-input" placeholder="Ask about code..." />
        <button id="send-btn" class="btn-primary" style="width: auto;">Send</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chat-container');
        const chatInput = document.getElementById('chat-input');
        const sendBtn = document.getElementById('send-btn');
        const indexBtn = document.getElementById('index-btn');
        const chunksCount = document.getElementById('chunks-count');
        const progressLog = document.getElementById('progress-log');

        let isIndexing = false;
        let isSearching = false;

        // Handle enter key
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });

        sendBtn.addEventListener('click', sendMessage);

        indexBtn.addEventListener('click', () => {
            if (isIndexing) return;
            isIndexing = true;
            indexBtn.disabled = true;
            indexBtn.innerHTML = '<span class="spinner"></span>Indexing...';
            progressLog.innerText = "Initializing scan...";
            vscode.postMessage({ type: 'indexWorkspace' });
        });

        function sendMessage() {
            const question = chatInput.value.trim();
            if (!question || isSearching || isIndexing) return;

            chatInput.value = '';
            
            // Add user message
            appendMessage(question, 'user');

            vscode.postMessage({
                type: 'askQuestion',
                question
            });
        }

        function appendMessage(text, role, sources = []) {
            const msgDiv = document.createElement('div');
            msgDiv.classList.add('message', role);
            
            // Parse linebreaks and inline code blocks
            const formattedText = text
                .split('\\n').join('<br/>')
                .split(String.fromCharCode(96))
                .map((part, i) => i % 2 === 1 ? '<code>' + part + '</code>' : part)
                .join('');
            msgDiv.innerHTML = formattedText;

            if (sources && sources.length > 0) {
                const sourcesDiv = document.createElement('div');
                sourcesDiv.classList.add('sources-container');
                sourcesDiv.innerHTML = '<strong>References:</strong>';
                
                sources.forEach(src => {
                    const link = document.createElement('a');
                    link.classList.add('source-link');
                    link.innerText = src.reference + ' (similarity: ' + src.similarity + ')';
                    link.addEventListener('click', () => {
                        vscode.postMessage({
                            type: 'openFile',
                            file: src.file,
                            line: src.line
                        });
                    });
                    sourcesDiv.appendChild(link);
                });
                msgDiv.appendChild(sourcesDiv);
            }

            chatContainer.appendChild(msgDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        // Listen for messages from extension host
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'updateIndexedCount':
                    chunksCount.innerText = message.count + ' chunks';
                    break;
                case 'indexingProgress':
                    progressLog.innerText = message.message;
                    break;
                case 'indexingComplete':
                    isIndexing = false;
                    indexBtn.disabled = false;
                    indexBtn.innerText = 'Index Workspace';
                    progressLog.innerText = 'Indexing complete!';
                    chunksCount.innerText = message.count + ' chunks';
                    break;
                case 'indexingError':
                    isIndexing = false;
                    indexBtn.disabled = false;
                    indexBtn.innerText = 'Index Workspace';
                    progressLog.innerText = 'Error: ' + message.error;
                    break;
                case 'searching':
                    isSearching = true;
                    appendMessage('<span class="spinner"></span>Searching index...', 'assistant');
                    break;
                case 'answerReceived':
                    isSearching = false;
                    // Remove loading spinner message
                    const lastMsg = chatContainer.lastElementChild;
                    if (lastMsg && lastMsg.innerText.includes('Searching index...')) {
                        chatContainer.removeChild(lastMsg);
                    }
                    if (!message.silent) {
                        appendMessage(message.answer, 'assistant', message.sources);
                    }
                    break;
                case 'answerError':
                    isSearching = false;
                    const lastMsgErr = chatContainer.lastElementChild;
                    if (lastMsgErr && lastMsgErr.innerText.includes('Searching index...')) {
                        chatContainer.removeChild(lastMsgErr);
                    }
                    appendMessage('Error querying AI: ' + message.error, 'assistant');
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
