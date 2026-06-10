import os
from groq import Groq
from retriever import get_all_chunks

MODEL = "llama-3.1-8b-instant"

FLOW_PROMPT = """You are a senior software architect.
You will be given code chunks from a project.
Generate a clean, well-structured flow.md file that explains:

1. Project Overview — what this project does in 2-3 sentences
2. Folder Structure — what each file/folder is responsible for
3. How It Works — step by step data flow from entry point to output
4. Key Functions — the most important functions/classes and what they do
5. Dependencies — what external libraries are used and why

Be concise, clear, and developer-friendly. Use markdown formatting.
Reference specific files like `filename.py:function_name`.
Do not make things up — only use what you see in the code."""

DIAGRAM_PROMPT = """You are a software architect. Based on the code chunks provided,
generate a Mermaid flowchart diagram showing how data flows through this project.

Rules:
- Use flowchart TD (top-down)
- Keep it simple, max 10-12 nodes
- Show the main flow from user input to output
- Use short node labels
- Only output the mermaid code block, nothing else

Example format:
```mermaid
flowchart TD
    A[User Input] --> B[FastAPI]
    B --> C[Indexer]
    C --> D[FAISS]
    D --> E[LLM]
    E --> F[Answer]
```"""


def generate_flow(source):
    chunks = get_all_chunks(source, limit=150)
    if not chunks:
        raise Exception("no chunks found — index the source first")

    # group by file
    files = {}
    for chunk in chunks:
        f = chunk["file"]
        if f not in files:
            files[f] = []
        files[f].append(chunk)

    # build context
    context_parts = []
    for filepath, file_chunks in list(files.items())[:40]:
        names   = [c["name"] for c in file_chunks if c["name"]]
        snippet = file_chunks[0]["code"][:300] if file_chunks else ""
        part    = f"### {filepath}\n"
        if names:
            part += f"Functions/Classes: {', '.join(names[:10])}\n"
        part += f"```\n{snippet}\n```\n"
        context_parts.append(part)

    context = "\n".join(context_parts)
    client  = Groq()

    # generate flow.md text
    flow_response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": FLOW_PROMPT},
            {"role": "user",   "content": f"Codebase:\n\n{context}\n\nGenerate the flow.md now."}
        ],
        temperature=0.3,
        max_tokens=2048
    )
    flow_md = flow_response.choices[0].message.content

    # generate mermaid diagram
    diagram_response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": DIAGRAM_PROMPT},
            {"role": "user",   "content": f"Codebase:\n\n{context}\n\nGenerate the mermaid flowchart now."}
        ],
        temperature=0.2,
        max_tokens=512
    )
    flow_diagram = diagram_response.choices[0].message.content

    return flow_md, flow_diagram
