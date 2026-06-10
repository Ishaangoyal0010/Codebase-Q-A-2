from sqlalchemy import text
from indexer import embeddings, get_engine


def retrieve(question, source, top_k=6):
    engine = get_engine()
    query_vec = embeddings.embed_query(question)
    vec_str   = "[" + ",".join(str(x) for x in query_vec) + "]"

    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT
                content,
                file,
                start_line,
                end_line,
                name,
                language,
                1 - (embedding <=> CAST(:vec AS vector)) AS similarity
            FROM chunks
            WHERE source = :src
            ORDER BY embedding <=> CAST(:vec AS vector)
            LIMIT :k
        """), {"vec": vec_str, "src": source, "k": top_k}).fetchall()

    chunks = []
    for row in rows:
        content, file, start, end, name, lang, score = row
        ref = f"{file}:{start}-{end}"
        if name:
            ref += f" ({name})"
        chunks.append({
            "code":       content,
            "file":       file,
            "start_line": start,
            "end_line":   end,
            "name":       name or "",
            "language":   lang or "",
            "similarity": round(float(score), 4),
            "reference":  ref
        })
    return chunks


def build_context(chunks):
    parts = []
    for i, chunk in enumerate(chunks, 1):
        parts.append(f"[{i}] {chunk['reference']}\n```{chunk['language']}\n{chunk['code']}\n```")
    return "\n\n".join(parts)


def get_all_chunks(source, limit=200):
    engine = get_engine()
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT content, file, start_line, end_line, name, language
            FROM chunks
            WHERE source = :src
            ORDER BY file, start_line
            LIMIT :lim
        """), {"src": source, "lim": limit}).fetchall()

    return [{
        "code":       r[0],
        "file":       r[1],
        "start_line": r[2],
        "end_line":   r[3],
        "name":       r[4] or "",
        "language":   r[5] or ""
    } for r in rows]
