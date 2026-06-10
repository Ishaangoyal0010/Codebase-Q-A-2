# Codebase Q&A v2

Ask questions about any GitHub repo or local directory. Get answers with exact file and line references. Generate a flow.md explaining the entire project architecture.

Built with LangChain, PostgreSQL + pgvector, Groq, FastAPI, and Streamlit.

---

## What's new in v2

- **PostgreSQL + pgvector** — index persists permanently across restarts
- **Local directory indexing** — point it at any folder on your machine
- **GitHub URL indexing** — still works from v1
- **Multiple sources** — index many projects, switch between them
- **flow.md generator** — auto-generates architecture documentation

---

## How it works

**Indexing**
1. Clone GitHub repo or read local directory
2. Python files chunked at function/class level using AST
3. Other files chunked with LangChain RecursiveCharacterTextSplitter
4. Each chunk embedded with all-MiniLM-L6-v2 (384-dim)
5. Stored in PostgreSQL with pgvector extension

**Querying**
1. Question embedded with same model
2. pgvector cosine similarity search finds top-6 chunks
3. Chunks + question sent to Groq llama-3.1-8b
4. Answer returned with exact file:line references

---

## Run with Docker

**Step 1 — Add your Groq key to .env**
```
GROQ_API_KEY=your_key_here
```
Get a free key at https://console.groq.com

**Step 2 — Start everything**
```bash
docker-compose up --build
```

- Frontend → http://localhost:8501
- Backend  → http://localhost:8000/docs
- Database → localhost:5432

---

## Run locally

```bash
python -m venv venv
venv\Scripts\activate.bat     # windows
source venv/bin/activate      # mac/linux

pip install -r requirements.txt

# start postgresql separately, then:
cd backend
uvicorn main:app --port 8000 --reload

# new terminal
cd frontend
streamlit run app.py
```

---

## API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | health check |
| GET | /sources | list all indexed sources |
| POST | /index/github | index a github repo |
| POST | /index/local | index a local directory |
| POST | /ask | ask a question |
| POST | /generate-flow | generate flow.md |

---

## Project structure

```
codebase-qa-v2/
├── backend/
│   ├── main.py            FastAPI app
│   ├── indexer.py         clone/local → chunk → embed → PostgreSQL
│   ├── retriever.py       pgvector similarity search
│   ├── llm.py             LangChain prompt + Groq API
│   ├── flow_generator.py  generates flow.md from indexed chunks
│   └── Dockerfile
├── frontend/
│   ├── app.py             Streamlit chat UI
│   └── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── .env
```

---

## Stack

- FastAPI — backend
- Streamlit — frontend
- LangChain — RAG pipeline
- PostgreSQL + pgvector — persistent vector storage
- all-MiniLM-L6-v2 — embeddings
- Groq (llama-3.1-8b) — free LLM
- Docker + Docker Compose — deployment
