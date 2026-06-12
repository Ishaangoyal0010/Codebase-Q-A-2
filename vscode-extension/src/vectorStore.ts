import * as fs from 'fs';
import * as path from 'path';
import { DocumentChunk } from './indexer';

export interface EmbeddedChunk {
    chunk: DocumentChunk;
    embedding: number[];
}

const API_URL = "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction";

export class LocalVectorStore {
    private indexFile: string;
    private embeddedChunks: EmbeddedChunk[] = [];
    private hfToken: string = "";

    constructor(storageDir: string) {
        this.indexFile = path.join(storageDir, 'vectorIndex.json');
        if (!fs.existsSync(storageDir)) {
            fs.mkdirSync(storageDir, { recursive: true });
        }
        this.load();
    }

    setKeys(hfToken: string) {
        this.hfToken = hfToken;
    }

    private load() {
        if (fs.existsSync(this.indexFile)) {
            try {
                const data = fs.readFileSync(this.indexFile, 'utf8');
                this.embeddedChunks = JSON.parse(data);
            } catch (e) {
                console.error("Failed to load vector index", e);
                this.embeddedChunks = [];
            }
        }
    }

    private save() {
        try {
            fs.writeFileSync(this.indexFile, JSON.stringify(this.embeddedChunks, null, 2), 'utf8');
        } catch (e) {
            console.error("Failed to save vector index", e);
        }
    }

    clear() {
        this.embeddedChunks = [];
        if (fs.existsSync(this.indexFile)) {
            try {
                fs.unlinkSync(this.indexFile);
            } catch (e) {}
        }
    }

    getChunkCount(): number {
        return this.embeddedChunks.length;
    }

    async getEmbeddings(texts: string[]): Promise<number[][]> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json"
        };
        if (this.hfToken) {
            headers["Authorization"] = `Bearer ${this.hfToken}`;
        }

        const response = await fetch(API_URL, {
            method: "POST",
            headers,
            body: JSON.stringify({ inputs: texts })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HuggingFace API Error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        
        if (data && typeof data === 'object' && 'error' in data) {
            throw new Error(`HF API error: ${data.error}`);
        }

        return data as number[][];
    }

    async indexChunks(chunks: DocumentChunk[], progressCallback: (msg: string) => void, append: boolean = false) {
        progressCallback("Beginning embedding calculations...");
        if (!append) {
            this.embeddedChunks = [];
        }
        
        const batchSize = 16;
        const totalChunks = chunks.length;
        
        for (let i = 0; i < totalChunks; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const texts = batch.map(c => c.pageContent);
            
            progressCallback(`Generating embeddings: ${i}/${totalChunks} chunks processed...`);
            
            try {
                const vectors = await this.getEmbeddings(texts);
                
                for (let j = 0; j < batch.length; j++) {
                    this.embeddedChunks.push({
                        chunk: batch[j],
                        embedding: vectors[j]
                    });
                }
            } catch (e: any) {
                progressCallback(`Embedding failed at chunk ${i}: ${e.message}. Retrying in 3 seconds...`);
                await new Promise(r => setTimeout(r, 3000));
                
                // Retry once
                try {
                    const vectors = await this.getEmbeddings(texts);
                    for (let j = 0; j < batch.length; j++) {
                        this.embeddedChunks.push({
                            chunk: batch[j],
                            embedding: vectors[j]
                        });
                    }
                } catch (retryErr: any) {
                    throw new Error(`Embedding batch failed: ${retryErr.message}`);
                }
            }
        }
        
        progressCallback("Successfully indexed all workspace files!");
        this.save();
    }

    async search(query: string, topK: number = 6): Promise<{ chunk: DocumentChunk; similarity: number }[]> {
        if (this.embeddedChunks.length === 0) {
            return [];
        }

        const queryVecs = await this.getEmbeddings([query]);
        const queryVec = queryVecs[0];

        const results = this.embeddedChunks.map(ec => {
            const similarity = this.cosineSimilarity(queryVec, ec.embedding);
            return {
                chunk: ec.chunk,
                similarity
            };
        });

        // Sort descending by similarity
        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, topK);
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        // Since Hugging Face embeddings are already L2 normalized unit vectors, 
        // cosine similarity is simply the dot product of the two vectors.
        let dot = 0;
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) {
            dot += a[i] * b[i];
        }
        return dot;
    }
}
