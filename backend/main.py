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


@app.get("/test-dns")
def test_dns():
    import socket
    import requests
    results = {}
    
    # 1. Test api-inference.huggingface.co
    results["api_inference"] = {}
    try:
        results["api_inference"]["local_dns"] = socket.gethostbyname("api-inference.huggingface.co")
    except Exception as e:
        results["api_inference"]["local_dns"] = f"Error: {e}"
        
    try:
        res = requests.get("https://1.1.1.1/dns-query", params={"name": "api-inference.huggingface.co", "type": "A"}, headers={"accept": "application/dns-json"}, timeout=5)
        results["api_inference"]["cf_doh"] = res.json()
    except Exception as e:
        results["api_inference"]["cf_doh"] = f"Error: {e}"

    try:
        res = requests.post("https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2", json={"inputs": ["test"]}, timeout=5)
        results["api_inference"]["http_status"] = res.status_code
    except Exception as e:
        results["api_inference"]["http_error"] = f"Error: {e}"
        
    # 2. Test router.huggingface.co (Newer gateway)
    results["router"] = {}
    try:
        results["router"]["local_dns"] = socket.gethostbyname("router.huggingface.co")
    except Exception as e:
        results["router"]["local_dns"] = f"Error: {e}"
        
    try:
        res = requests.get("https://1.1.1.1/dns-query", params={"name": "router.huggingface.co", "type": "A"}, headers={"accept": "application/dns-json"}, timeout=5)
        results["router"]["cf_doh"] = res.json()
    except Exception as e:
        results["router"]["cf_doh"] = f"Error: {e}"

    try:
        # Test feature extraction on the new router endpoint
        import os
        token = os.getenv("HF_TOKEN")
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        res = requests.post("https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction", json={"inputs": ["test"]}, headers=headers, timeout=5)
        results["router"]["http_status"] = res.status_code
        if res.status_code == 200:
            results["router"]["http_response_type"] = str(type(res.json()))
            try:
                results["router"]["embedding_len"] = len(res.json()[0])
            except:
                pass
    except Exception as e:
        results["router"]["http_error"] = f"Error: {e}"
        
    results["version"] = "v6-router-pip"
    return results





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
