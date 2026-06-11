import { DocumentChunk } from './indexer';

export interface SearchResult {
    chunk: DocumentChunk;
    similarity: number;
}

export class GroqClient {
    private groqApiKey: string = "";
    private model: string = "llama-3.1-8b-instant";

    setKeys(groqApiKey: string) {
        this.groqApiKey = groqApiKey;
    }

    async ask(question: string, searchResults: SearchResult[]): Promise<string> {
        if (!this.groqApiKey) {
            throw new Error("Groq API Key is not set. Use command 'Codebase Q&A: Configure API Keys' to set it.");
        }

        // Build context string
        const contextParts = searchResults.map((res, index) => {
            const c = res.chunk;
            return `[${index + 1}] ${c.filePath}:${c.startLine}-${c.endLine}\n\`\`\`${c.language}\n${c.pageContent}\n\`\`\``;
        });
        const context = contextParts.join("\n\n");

        const systemPrompt = 
            "You are a codebase assistant. Answer questions using the provided file chunks (which can include code, configuration, or documentation files like README.md).\n" +
            "Always mention the exact file and line number like `auth/middleware.py:42` or `README.md:12`.\n" +
            "Cite sources using [1], [2] etc.\n" +
            "If the answer cannot be found or inferred from the provided chunks, say so.";

        const userPrompt = `File chunks:\n\n${context}\n\nQuestion: ${question}`;

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.groqApiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.2,
                max_tokens: 1024
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Groq API Error (${response.status}): ${errText}`);
        }

        const data: any = await response.json();
        
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return data.choices[0].message.content;
        }

        throw new Error("Invalid response received from Groq API.");
    }
}
