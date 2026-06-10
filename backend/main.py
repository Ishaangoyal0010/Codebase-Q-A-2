from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import indexer
from indexer import index_local, index_github, get_indexed_sources, get_chunk_count
from retriever import retrieve
from llm import ask_llm
from flow_generator import generate_flow

app = FastAPI(title="Codebase Q&A v2")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)


class IndexGithubRequest(BaseModel):
    repo_url: str


class IndexLocalRequest(BaseModel):
    local_path: str


class AskRequest(BaseModel):
    question:   str
    source:     str
    top_k:      int = 6


class FlowRequest(BaseModel):
    source: str


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/sources")
def sources():
    try:
        all_sources = get_indexed_sources()
        return {"sources": all_sources}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/index/github")
def index_from_github(req: IndexGithubRequest):
    try:
        stats = index_github(req.repo_url)
        return {"message": "done", **stats}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/index/local")
def index_from_local(req: IndexLocalRequest):
    try:
        stats = index_local(req.local_path)
        return {"message": "done", **stats}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/ask")
def ask(req: AskRequest):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="question is empty")

    count = get_chunk_count(req.source)
    if count == 0:
        raise HTTPException(status_code=400, detail="source not indexed yet")

    chunks = retrieve(req.question, req.source, top_k=req.top_k)
    if not chunks:
        raise HTTPException(status_code=404, detail="no relevant code found")

    result = ask_llm(req.question, chunks)
    return result


@app.post("/generate-flow")
def generate_flow_md(req: FlowRequest):
    count = get_chunk_count(req.source)
    if count == 0:
        raise HTTPException(status_code=400, detail="source not indexed yet")

    try:
        flow_md, flow_diagram = generate_flow(req.source)
        return {"flow_md": flow_md, "flow_diagram": flow_diagram, "source": req.source}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
