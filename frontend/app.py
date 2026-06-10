import os
import streamlit as st
import requests
from dotenv import load_dotenv

load_dotenv()

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")

st.set_page_config(page_title="Codebase Q&A v2", page_icon="🔍", layout="wide")

st.markdown("""
<style>
#MainMenu, footer { visibility: hidden; }
section.main > div { padding-bottom: 90px; }
section[data-testid="stSidebar"] { background: #161b22; }
</style>
""", unsafe_allow_html=True)

st.title("🔍 Codebase Q&A v2")
st.caption("Index any GitHub repo or local directory — ask questions, generate flow.md")

# ── greetings and off-topic handler ──────────────────────────────
GREETINGS = [
    "hello", "hi", "hey", "hii", "helo", "sup", "yo", "namaste",
    "good morning", "good evening", "good afternoon", "good night",
    "how are you", "how r you", "how are u", "what's up", "whats up",
    "how do you do", "greetings", "howdy"
]

GREETING_REPLIES = {
    "how are you": "I'm doing great, thanks for asking! 😊 Ready to help you explore any codebase. Index a GitHub repo or local directory and ask away!",
    "how r you": "I'm doing great, thanks for asking! 😊 Ready to help you explore any codebase.",
    "how are u": "I'm doing great, thanks for asking! 😊 Ready to help you explore any codebase.",
}

DEFAULT_GREETING = "Hello! 👋 How can I help you? I'm a codebase assistant — index a GitHub repo or local directory and I'll answer questions about the code with exact file and line references."

OFF_TOPIC_KEYWORDS = [
    "what time", "what date", "what day", "weather", "news", "sports",
    "movie", "song", "tell me a joke", "joke", "recipe", "cook",
    "travel", "hotel", "capital of", "president", "prime minister",
    "how old", "born", "biography", "stock", "share price", "currency",
    "crypto", "bitcoin", "calculate", "what is 2", "translate",
    "who are you", "what are you", "your name", "who made you",
    "how much", "phone number", "address"
]

def handle_special(question):
    q = question.lower().strip()

    # check specific greeting replies first
    for key, reply in GREETING_REPLIES.items():
        if key in q:
            return reply

    # check general greetings
    if any(q == g or q.startswith(g) for g in GREETINGS):
        return DEFAULT_GREETING

    # check off-topic
    if any(k in q for k in OFF_TOPIC_KEYWORDS):
        return ("I'm specialized for codebase analysis only. I can help you with:\n\n"
                "- Understanding what a function or class does\n"
                "- Finding where specific logic is implemented\n"
                "- Explaining how different parts of the code connect\n"
                "- Identifying libraries and dependencies used\n\n"
                "Please index a codebase and ask me something about the code!")
    return None

# ── sidebar ───────────────────────────────────────────────────────
with st.sidebar:
    st.header("📦 Index a Codebase")

    tab_gh, tab_local = st.tabs(["GitHub URL", "Local Path"])

    with tab_gh:
        repo_url = st.text_input("GitHub URL", placeholder="https://github.com/user/repo")
        if st.button("🚀 Index GitHub Repo", use_container_width=True, type="primary"):
            if not repo_url.strip():
                st.error("paste a github url first")
            else:
                with st.spinner("cloning and indexing..."):
                    try:
                        res = requests.post(f"{BACKEND_URL}/index/github",
                                            json={"repo_url": repo_url}, timeout=300)
                        data = res.json()
                        if res.status_code == 200:
                            st.success(f"✅ {data['files_indexed']} files, {data['chunks_stored']} chunks")
                            st.session_state.active_source = data["source"]
                        else:
                            st.error(data.get("detail", "error"))
                    except Exception as e:
                        st.error(f"could not reach backend: {e}")

    with tab_local:
        local_path = st.text_input("Local Path", placeholder="E:\\myproject")
        if st.button("🚀 Index Local Directory", use_container_width=True, type="primary"):
            if not local_path.strip():
                st.error("enter a local path first")
            else:
                with st.spinner("indexing local directory..."):
                    try:
                        res = requests.post(f"{BACKEND_URL}/index/local",
                                            json={"local_path": local_path}, timeout=300)
                        data = res.json()
                        if res.status_code == 200:
                            st.success(f"✅ {data['files_indexed']} files, {data['chunks_stored']} chunks")
                            st.session_state.active_source = data["source"]
                        else:
                            st.error(data.get("detail", "error"))
                    except Exception as e:
                        st.error(f"could not reach backend: {e}")

    st.divider()

    st.subheader("📂 Indexed Sources")
    try:
        res = requests.get(f"{BACKEND_URL}/sources", timeout=10)
        if res.status_code == 200:
            all_sources = res.json().get("sources", [])
            if all_sources:
                selected = st.selectbox("Select source to query", all_sources, index=0)
                st.session_state.active_source = selected
            else:
                st.info("no sources indexed yet")
    except:
        st.warning("backend not reachable")

    st.divider()
    if st.button("🗑 Clear Chat", use_container_width=True):
        st.session_state.messages = []
        st.rerun()

# ── main tabs ─────────────────────────────────────────────────────
chat_tab, flow_tab = st.tabs(["💬 Ask Questions", "📄 Generate flow.md"])

# ── CHAT TAB ──────────────────────────────────────────────────────
with chat_tab:
    if "messages" not in st.session_state:
        st.session_state.messages = []

    if not st.session_state.messages:
        st.info("👈 Index a repo or local directory, then ask anything:\n\n"
                "- *Where is auth handled?*\n"
                "- *What does the login function do?*\n"
                "- *How is the database connected?*")

    for msg in st.session_state.messages:
        with st.chat_message(msg["role"]):
            st.markdown(msg["content"])
            if msg["role"] == "assistant" and msg.get("sources"):
                with st.expander("📁 source references"):
                    for src in msg["sources"]:
                        col1, col2 = st.columns([3, 1])
                        with col1:
                            st.code(src["reference"], language="text")
                        with col2:
                            st.metric("similarity", src["similarity"])

    question = st.chat_input("ask something about the code...")

    if question:
        source = st.session_state.get("active_source", "")

        st.session_state.messages.append({"role": "user", "content": question})
        with st.chat_message("user"):
            st.markdown(question)

        # check greetings / off-topic first
        special_reply = handle_special(question)

        if special_reply:
            with st.chat_message("assistant"):
                st.markdown(special_reply)
            st.session_state.messages.append({
                "role": "assistant", "content": special_reply, "sources": []
            })
            st.rerun()

        elif not source:
            reply = "Please select or index a source from the sidebar first before asking code questions!"
            with st.chat_message("assistant"):
                st.markdown(reply)
            st.session_state.messages.append({
                "role": "assistant", "content": reply, "sources": []
            })
            st.rerun()

        else:
            with st.chat_message("assistant"):
                with st.spinner("searching codebase..."):
                    try:
                        res = requests.post(f"{BACKEND_URL}/ask",
                                            json={"question": question,
                                                  "source": source,
                                                  "top_k": 6},
                                            timeout=60)
                        data = res.json()
                        if res.status_code == 200:
                            answer  = data["answer"]
                            sources = data["sources"]
                            st.markdown(answer)
                            with st.expander("📁 source references"):
                                for src in sources:
                                    col1, col2 = st.columns([3, 1])
                                    with col1:
                                        st.code(src["reference"], language="text")
                                    with col2:
                                        st.metric("similarity", src["similarity"])
                            st.session_state.messages.append({
                                "role": "assistant",
                                "content": answer,
                                "sources": sources
                            })
                            st.rerun()
                        else:
                            err = data.get("detail", "something went wrong")
                            st.error(err)
                            st.session_state.messages.append({
                                "role": "assistant", "content": f"error: {err}", "sources": []
                            })
                            st.rerun()
                    except Exception as e:
                        err_msg = f"could not reach backend: {e}"
                        st.error(err_msg)
                        st.session_state.messages.append({
                            "role": "assistant", "content": f"error: {err_msg}", "sources": []
                        })
                        st.rerun()

# ── FLOW.MD TAB ───────────────────────────────────────────────────
with flow_tab:
    st.subheader("Generate flow.md")
    st.caption("Auto-generates a structured markdown file explaining the project architecture, data flow, and key functions.")

    source = st.session_state.get("active_source", "")
    if source:
        st.info(f"will generate for:\n`{source}`")
    else:
        st.warning("select a source from the sidebar first")

    if st.button("✨ Generate flow.md", type="primary", disabled=not source):
        with st.spinner("analysing codebase and generating flow.md..."):
            try:
                res = requests.post(f"{BACKEND_URL}/generate-flow",
                                    json={"source": source},
                                    timeout=120)
                data = res.json()
                if res.status_code == 200:
                    st.session_state.flow_md      = data["flow_md"]
                    st.session_state.flow_diagram  = data.get("flow_diagram", "")
                    st.success("✅ flow.md generated!")
                else:
                    st.error(data.get("detail", "error generating flow.md"))
            except Exception as e:
                st.error(f"could not reach backend: {e}")

    if st.session_state.get("flow_md"):
        st.divider()

        if st.session_state.get("flow_diagram"):
            st.subheader("📊 Architecture Diagram")
            st.markdown(st.session_state.flow_diagram)
            st.divider()

        col1, col2 = st.columns([1, 1])
        with col1:
            st.subheader("Preview")
            st.markdown(st.session_state.flow_md)
        with col2:
            st.subheader("Raw Markdown")
            st.code(st.session_state.flow_md, language="markdown")
            st.download_button(
                label="⬇️ Download flow.md",
                data=st.session_state.flow_md,
                file_name="flow.md",
                mime="text/markdown",
                use_container_width=True
            )
