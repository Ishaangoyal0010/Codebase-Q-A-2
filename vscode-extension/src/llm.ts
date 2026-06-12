import { DocumentChunk } from './indexer';

export interface SearchResult {
    chunk: DocumentChunk;
    similarity: number;
}

export interface LLMConfig {
    provider: string;
    model: string;
    systemPrompt: string;
    ollamaUrl?: string;
}

export class LLMClientManager {
    private keys: Record<string, string> = {};

    setKeys(keys: Record<string, string>) {
        this.keys = keys;
    }

    async ask(question: string, searchResults: SearchResult[], config: LLMConfig): Promise<string> {
        // Build context string
        const contextParts = searchResults.map((res, index) => {
            const c = res.chunk;
            return `[${index + 1}] ${c.filePath}:${c.startLine}-${c.endLine}\n\`\`\`${c.language || 'text'}\n${c.pageContent}\n\`\`\``;
        });
        const context = contextParts.join("\n\n");

        const systemPrompt = config.systemPrompt;
        const userPrompt = `File chunks:\n\n${context}\n\nQuestion: ${question}`;

        switch (config.provider) {
            case 'groq':
                return this.askGroq(userPrompt, systemPrompt, config.model);
            case 'openai':
                return this.askOpenAI(userPrompt, systemPrompt, config.model);
            case 'anthropic':
                return this.askAnthropic(userPrompt, systemPrompt, config.model);
            case 'gemini':
                return this.askGemini(userPrompt, systemPrompt, config.model);
            case 'ollama':
                return this.askOllama(userPrompt, systemPrompt, config.model, config.ollamaUrl || "http://localhost:11434");
            default:
                throw new Error(`Unsupported LLM provider: ${config.provider}`);
        }
    }

    private async askGroq(userPrompt: string, systemPrompt: string, model: string): Promise<string> {
        const apiKey = this.keys['groq_api_key'];
        if (!apiKey) {
            throw new Error("Groq API Key is not set. Please configure it in the extension settings.");
        }

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model,
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

    private async askOpenAI(userPrompt: string, systemPrompt: string, model: string): Promise<string> {
        const apiKey = this.keys['openai_api_key'];
        if (!apiKey) {
            throw new Error("OpenAI API Key is not set. Please configure it in the extension settings.");
        }

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model,
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
            throw new Error(`OpenAI API Error (${response.status}): ${errText}`);
        }

        const data: any = await response.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return data.choices[0].message.content;
        }
        throw new Error("Invalid response received from OpenAI API.");
    }

    private async askAnthropic(userPrompt: string, systemPrompt: string, model: string): Promise<string> {
        const apiKey = this.keys['anthropic_api_key'];
        if (!apiKey) {
            throw new Error("Anthropic API Key is not set. Please configure it in the extension settings.");
        }

        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: model,
                system: systemPrompt,
                messages: [
                    { role: "user", content: userPrompt }
                ],
                max_tokens: 1024,
                temperature: 0.2
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Anthropic API Error (${response.status}): ${errText}`);
        }

        const data: any = await response.json();
        if (data.content && data.content[0] && data.content[0].text) {
            return data.content[0].text;
        }
        throw new Error("Invalid response received from Anthropic API.");
    }

    private async askGemini(userPrompt: string, systemPrompt: string, model: string): Promise<string> {
        const apiKey = this.keys['gemini_api_key'];
        if (!apiKey) {
            throw new Error("Gemini API Key is not set. Please configure it in the extension settings.");
        }

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                systemInstruction: {
                    parts: [
                        { text: systemPrompt }
                    ]
                },
                contents: [
                    {
                        role: "user",
                        parts: [
                            { text: userPrompt }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 1024
                }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Gemini API Error (${response.status}): ${errText}`);
        }

        const data: any = await response.json();
        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) {
            return data.candidates[0].content.parts[0].text;
        }
        throw new Error("Invalid response received from Gemini API.");
    }

    private async askOllama(userPrompt: string, systemPrompt: string, model: string, ollamaUrl: string): Promise<string> {
        const url = `${ollamaUrl.replace(/\/$/, '')}/api/chat`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                options: {
                    temperature: 0.2
                },
                stream: false
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Ollama API Error (${response.status}): ${errText}`);
        }

        const data: any = await response.json();
        if (data.message && data.message.content) {
            return data.message.content;
        }
        throw new Error("Invalid response received from Ollama API.");
    }
}
