import os
from groq import Groq
from langchain.prompts import ChatPromptTemplate
from retriever import build_context

MODEL = "llama-3.1-8b-instant"

prompt_template = ChatPromptTemplate.from_messages([
    ("system", (
        "You are a codebase assistant. Answer questions using the provided file chunks (which can include code, configuration, or documentation files like README.md). "
        "Always mention the exact file and line number like `auth/middleware.py:42` or `README.md:12`. "
        "Cite sources using [1], [2] etc. "
        "If the answer cannot be found or inferred from the provided chunks, say so."
    )),
    ("human", "File chunks:\n\n{context}\n\nQuestion: {question}")
])


def ask_llm(question, chunks):
    client  = Groq()
    context = build_context(chunks)

    formatted   = prompt_template.format_messages(context=context, question=question)
    system_msg  = formatted[0].content
    user_msg    = formatted[1].content

    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": system_msg},
            {"role": "user",   "content": user_msg}
        ],
        temperature=0.2,
        max_tokens=1024
    )

    answer  = response.choices[0].message.content
    sources = [{
        "reference":  c["reference"],
        "file":       c["file"],
        "start_line": c["start_line"],
        "end_line":   c["end_line"],
        "similarity": c["similarity"]
    } for c in chunks]

    return {"answer": answer, "sources": sources, "model": MODEL}
