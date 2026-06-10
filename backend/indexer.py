import os
import ast
import stat
import shutil
import hashlib
import subprocess
from pathlib import Path

import time
import requests
import socket
import urllib3.util.connection as connection

# ── DNS caching patch to prevent Render DNS throttling ────────────────
_orig_create_connection = connection.create_connection
dns_cache = {}

def resolve_via_doh():
    # Try Cloudflare DoH (direct IP connection to bypass local DNS)
    try:
        res = requests.get(
            "https://1.1.1.1/dns-query",
            params={"name": "router.huggingface.co", "type": "A"},
            headers={"accept": "application/dns-json"},
            timeout=5
        )
        data = res.json()
        for answer in data.get("Answer", []):
            if answer.get("type") == 1: # A record
                return answer.get("data")
    except Exception:
        pass
    # Try Google DoH (direct IP connection to bypass local DNS)
    try:
        res = requests.get(
            "https://8.8.8.8/resolve",
            params={"name": "router.huggingface.co", "type": "A"},
            timeout=5
        )
        data = res.json()
        for answer in data.get("Answer", []):
            if answer.get("type") == 1: # A record
                return answer.get("data")
    except Exception:
        pass
    return None

def patched_create_connection(address, *args, **kwargs):
    host, port = address
    if host == "router.huggingface.co":
        if host not in dns_cache:
            for _ in range(3):
                try:
                    dns_cache[host] = socket.gethostbyname(host)
                    break
                except Exception:
                    # Fallback to DNS-over-HTTPS (DoH)
                    doh_ip = resolve_via_doh()
                    if doh_ip:
                        dns_cache[host] = doh_ip
                        break
                    time.sleep(1)
        if host in dns_cache:
            return _orig_create_connection((dns_cache[host], port), *args, **kwargs)
    return _orig_create_connection(address, *args, **kwargs)

connection.create_connection = patched_create_connection


from langchain.schema import Document
from langchain.text_splitter import RecursiveCharacterTextSplitter
from sqlalchemy import create_engine, text

# ── embedding model (API-based to prevent Out of Memory on Render Free tier) ──
API_URL = "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction"



class HuggingFaceAPIEmbeddings:
    def __init__(self, token=None):
        self.token = token
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}

    def _get_embeddings(self, texts):
        retries = 5
        delay = 5
        for i in range(retries):
            try:
                res = requests.post(API_URL, headers=self.headers, json={"inputs": texts}, timeout=30)
                data = res.json()
                if isinstance(data, dict) and "error" in data:
                    if "loading" in data["error"].lower():
                        # Model loading on HF servers, wait and retry
                        time.sleep(delay)
                        continue
                    raise Exception(data["error"])
                return data
            except Exception as e:
                if i == retries - 1:
                    raise e
                time.sleep(delay)
        raise Exception("Failed to get embeddings from HuggingFace API after retries.")

    def embed_documents(self, texts):
        # Batch to avoid HTTP timeout/payload limits
        batch_size = 32
        all_embeddings = []
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i+batch_size]
            embeddings = self._get_embeddings(batch)
            all_embeddings.extend(embeddings)
        return all_embeddings

    def embed_query(self, text):
        res = self._get_embeddings([text])
        return res[0]

embeddings = HuggingFaceAPIEmbeddings(os.getenv("HF_TOKEN"))


# ── db connection ─────────────────────────────────────────────────
def get_engine():
    url = os.getenv("DATABASE_URL", "postgresql://raguser:ragpass@db:5432/ragdb")
    if url and url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return create_engine(url)


def setup_db():
    engine = get_engine()
    with engine.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS chunks (
                id          TEXT PRIMARY KEY,
                source      TEXT NOT NULL,
                file        TEXT NOT NULL,
                start_line  INTEGER,
                end_line    INTEGER,
                name        TEXT,
                language    TEXT,
                content     TEXT NOT NULL,
                embedding   vector(384)
            )
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS chunks_embedding_idx
            ON chunks USING ivfflat (embedding vector_cosine_ops)
            WITH (lists = 100)
        """))
        conn.commit()

def clear_source(source, engine):
    with engine.connect() as conn:
        conn.execute(text("DELETE FROM chunks WHERE source = :src"), {"src": source})
        conn.commit()

# ── file walking ──────────────────────────────────────────────────
ALLOWED = {".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".go", ".cpp", ".c", ".rb", ".rs", ".cs"}
SKIP    = {"node_modules", ".git", "__pycache__", "venv", ".venv", "dist", "build", ".next"}

def get_all_files(folder):
    files = []
    for path in Path(folder).rglob("*"):
        if any(s in path.parts for s in SKIP):
            continue
        if path.suffix in ALLOWED and path.is_file():
            files.append(path)
    return files

# ── chunking ──────────────────────────────────────────────────────
def chunk_python(source, lines, rel_path):
    docs = []
    try:
        tree = ast.parse(source)
    except:
        return chunk_by_splitter(source, rel_path, "py")

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            start = node.lineno - 1
            end   = node.end_lineno
            code  = "\n".join(lines[start:end])
            if len(code.strip()) < 30:
                continue
            docs.append(Document(
                page_content=code,
                metadata={
                    "file":       rel_path,
                    "start_line": node.lineno,
                    "end_line":   node.end_lineno,
                    "name":       node.name,
                    "language":   "py"
                }
            ))
    return docs if docs else chunk_by_splitter(source, rel_path, "py")

def chunk_by_splitter(source, rel_path, lang):
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=1500, chunk_overlap=200,
        separators=["\nclass ", "\ndef ", "\n\n", "\n", " "]
    )
    lines = source.splitlines()
    docs  = []
    for chunk in splitter.split_text(source):
        try:
            start = next(i+1 for i, line in enumerate(lines) if line.strip() and line.strip() in chunk)
        except:
            start = 1
        docs.append(Document(
            page_content=chunk,
            metadata={
                "file":       rel_path,
                "start_line": start,
                "end_line":   min(start + chunk.count("\n"), len(lines)),
                "name":       "",
                "language":   lang
            }
        ))
    return docs

def load_file(file_path, root):
    try:
        source = file_path.read_text(encoding="utf-8", errors="ignore")
    except:
        return []
    rel_path = str(file_path.relative_to(root))
    lang     = file_path.suffix.lstrip(".")
    lines    = source.splitlines()
    if file_path.suffix == ".py":
        return chunk_python(source, lines, rel_path)
    return chunk_by_splitter(source, rel_path, lang)

# ── windows-safe delete ───────────────────────────────────────────
def force_remove(path):
    def handle(func, p, exc):
        os.chmod(p, stat.S_IWRITE)
        func(p)
    shutil.rmtree(path, onerror=handle)

# ── embed + store ─────────────────────────────────────────────────
def store_docs(docs, source, engine):
    if not docs:
        return
    texts  = [d.page_content for d in docs]
    vecs   = embeddings.embed_documents(texts)
    with engine.connect() as conn:
        for doc, vec in zip(docs, vecs):
            m   = doc.metadata
            uid = hashlib.md5(f"{source}:{m['file']}:{m['start_line']}".encode()).hexdigest()
            conn.execute(text("""
                INSERT INTO chunks (id, source, file, start_line, end_line, name, language, content, embedding)
                VALUES (:id, :source, :file, :start_line, :end_line, :name, :language, :content, :embedding)
                ON CONFLICT (id) DO UPDATE SET
                    content   = EXCLUDED.content,
                    embedding = EXCLUDED.embedding
            """), {
                "id":         uid,
                "source":     source,
                "file":       m["file"],
                "start_line": m["start_line"],
                "end_line":   m["end_line"],
                "name":       m.get("name", ""),
                "language":   m.get("language", ""),
                "content":    doc.page_content,
                "embedding":  str(vec)
            })
        conn.commit()

# ── main entry points ─────────────────────────────────────────────
def index_local(local_path: str):
    engine = get_engine()
    setup_db()
    folder = Path(local_path)
    if not folder.exists():
        raise Exception(f"path does not exist: {local_path}")

    source = str(folder.resolve())
    clear_source(source, engine)

    files      = get_all_files(folder)
    all_docs   = []
    for f in files:
        all_docs.extend(load_file(f, folder))

    if not all_docs:
        raise Exception("no source files found in that directory")

    store_docs(all_docs, source, engine)
    return {"files_indexed": len(files), "chunks_stored": len(all_docs), "source": source}


def index_github(repo_url: str):
    tmp = "./tmp_repo"
    if os.path.exists(tmp):
        force_remove(tmp)

    result = subprocess.run(
        ["git", "clone", "--depth", "1", repo_url, tmp],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise Exception(f"git clone failed: {result.stderr}")

    engine = get_engine()
    setup_db()
    clear_source(repo_url, engine)

    files    = get_all_files(tmp)
    all_docs = []
    for f in files:
        all_docs.extend(load_file(f, Path(tmp)))

    if not all_docs:
        force_remove(tmp)
        raise Exception("no source files found in repo")

    store_docs(all_docs, repo_url, engine)
    force_remove(tmp)

    return {"files_indexed": len(files), "chunks_stored": len(all_docs), "source": repo_url}


def get_indexed_sources():
    engine = get_engine()
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT DISTINCT source FROM chunks")).fetchall()
    return [r[0] for r in rows]


def get_chunk_count(source):
    engine = get_engine()
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT COUNT(*) FROM chunks WHERE source = :src"),
            {"src": source}
        ).fetchone()
    return row[0] if row else 0
