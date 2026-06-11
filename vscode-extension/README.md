# Codebase Q&A VS Code Extension

Ask questions and search through your local workspace files using serverless Hugging Face embeddings and Groq LLMs. Completely lightweight, with no Docker or local database setup required.

## Features

- **Local Scan & Index**: Walks your workspace and chunks files locally.
- **Serverless embeddings**: Uses Hugging Face API to embed codebase chunks.
- **Local vector search**: Computes cosine similarity in JavaScript directly within VS Code.
- **Side Panel Chat View**: Ask questions and view code citations in a visual panel.
- **Interactive references**: Click any reference link in the chat to auto-open that file and highlight the cited code line!

## Setup

1. Open a workspace folder in VS Code.
2. Open the **Codebase Q&A** panel in the activity bar.
3. Configure your API Keys using the command **Codebase Q&A: Configure API Keys** (requires a Groq API Key and a free Hugging Face API token).
4. Click **Index Workspace** to scan and generate embeddings.
5. Start asking questions in the chat panel!
