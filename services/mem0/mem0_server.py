"""
Mem0 context/memory compaction server for OmniRoute-LEV.

Provides a REST API for:
  - Adding memories from conversation context
  - Searching relevant memories for a query
  - Compacting long conversation histories into concise summaries
  - Health checks

Uses mem0ai with Postgres+pgvector backend (shared with OmniRoute).
"""
import os
import json
import logging
from typing import Optional
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("mem0-server")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Mem0-LEV", version="1.0.0")

# ── Configuration ──────────────────────────────────────────────────────────
POSTGRES_URL = os.getenv("DATABASE_URL", os.getenv("POSTGRES_URL", ""))
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
API_KEY = os.getenv("API_KEY", "lev-mem0-prod-2026")

# ── Embedder / LLM wiring ──────────────────────────────────────────────────
# Local-first: sentence-transformers runs in-process, so semantic memory needs
# no external key. all-MiniLM-L6-v2 emits 384-dim vectors — EMBEDDING_DIMS must
# track whatever model is selected or pgvector inserts fail on width mismatch.
EMBEDDER_PROVIDER = os.getenv("MEM0_EMBEDDER_PROVIDER", "huggingface").strip().lower()
EMBEDDER_MODEL = os.getenv(
    "MEM0_EMBEDDER_MODEL",
    "text-embedding-3-small" if EMBEDDER_PROVIDER == "openai" else "all-MiniLM-L6-v2",
)
EMBEDDING_DIMS = int(os.getenv("MEM0_EMBEDDING_DIMS", "1536" if EMBEDDER_PROVIDER == "openai" else "384"))

# Fact-extraction LLM. Defaults to OmniRoute's own gateway over the Railway
# private network so no external LLM account is required.
LLM_BASE_URL = os.getenv("MEM0_LLM_BASE_URL", "").strip()
LLM_MODEL = os.getenv("MEM0_LLM_MODEL", "gpt-4o-mini")
LLM_API_KEY = os.getenv("MEM0_LLM_API_KEY", "").strip()

# Whether mem0 runs LLM fact-extraction on add(). Extraction over a full
# long-context conversation is the slowest thing in this service and sits on the
# hot path of every compaction, so it is opt-in.
INFER_ON_ADD = os.getenv("MEM0_INFER_ON_ADD", "false").strip().lower() in ("1", "true", "yes")

# ── Mem0 client (lazy init) ────────────────────────────────────────────────
_mem0_client = None
_last_init_error = None

def get_mem0():
    global _mem0_client, _last_init_error
    if _mem0_client is not None:
        return _mem0_client
    try:
        from mem0 import Memory

        # Vector store — Postgres + pgvector on the existing Railway Postgres.
        # embedding_model_dims MUST match the embedder's output width or every
        # insert fails: the local MiniLM default is 384, not OpenAI's 1536.
        config = {
            "vector_store": {
                "provider": "pgvector",
                "config": {
                    "dbname": os.getenv("POSTGRES_DB", "postgres"),
                    "collection_name": os.getenv("MEM0_COLLECTION", "mem0_memories"),
                    "host": os.getenv("POSTGRES_HOST", "localhost"),
                    "port": int(os.getenv("POSTGRES_PORT", "5432")),
                    "user": os.getenv("POSTGRES_USER", "postgres"),
                    "password": os.getenv("POSTGRES_PASSWORD", ""),
                    "embedding_model_dims": EMBEDDING_DIMS,
                },
            },
        }

        # Embedder — local sentence-transformers by default, so vector memory
        # needs no external API key and costs nothing per request. Falls back to
        # OpenAI only when a key is explicitly provided.
        if EMBEDDER_PROVIDER == "openai" and OPENAI_API_KEY:
            config["embedder"] = {
                "provider": "openai",
                "config": {"api_key": OPENAI_API_KEY, "model": EMBEDDER_MODEL},
            }
        else:
            config["embedder"] = {
                "provider": "huggingface",
                "config": {"model": EMBEDDER_MODEL, "embedding_dims": EMBEDDING_DIMS},
            }

        # LLM for fact extraction. Points at OmniRoute's own OpenAI-compatible
        # gateway by default, so memory extraction runs on the providers this
        # deployment already has rather than a separate vendor account.
        if OPENAI_API_KEY and LLM_BASE_URL == "":
            config["llm"] = {
                "provider": "openai",
                "config": {"api_key": OPENAI_API_KEY, "model": LLM_MODEL},
            }
        elif LLM_BASE_URL:
            config["llm"] = {
                "provider": "openai",
                "config": {
                    "api_key": LLM_API_KEY or "omniroute",
                    "model": LLM_MODEL,
                    "openai_base_url": LLM_BASE_URL,
                },
            }

        _mem0_client = Memory.from_config(config)
        logger.info(
            "Mem0 initialized (vector_store=pgvector dims=%s embedder=%s/%s llm=%s@%s)",
            EMBEDDING_DIMS,
            config["embedder"]["provider"],
            EMBEDDER_MODEL,
            LLM_MODEL,
            LLM_BASE_URL or "openai",
        )
    except Exception as e:
        _last_init_error = f"{type(e).__name__}: {e}"[:300]
        logger.warning(f"Mem0 init failed (running in stub mode): {e}")
        _mem0_client = None
    return _mem0_client


def _search(client, query: str, user_id: str, limit: int = 10):
    """Call mem0's search across API versions.

    Newer mem0ai moved entity scoping out of the top-level kwargs:
      "Top-level entity parameters frozenset({'user_id'}) are not supported in
       search(). Use filters={'user_id': '...'} instead."
    Older builds only accept the top-level form, so try the current signature
    first and fall back rather than pinning the caller to one mem0 release.
    """
    try:
        return client.search(query=query, filters={"user_id": user_id}, limit=limit)
    except TypeError:
        return client.search(query=query, user_id=user_id, limit=limit)
    except ValueError as e:
        if "filters" in str(e) or "Top-level entity" in str(e):
            return client.search(query=query, user_id=user_id, limit=limit)
        raise


def _memory_texts(search_result) -> list:
    """Normalise mem0 search output into a list of memory strings.

    Two shapes have to be handled, and getting either wrong fails silently:
      * newer mem0 returns {"results": [...]}, so iterating the value directly
        walks the dict KEYS — every item is a str, isinstance(m, dict) is False,
        and the caller builds an empty summary while believing it searched;
      * the stored payload key is "data" when add() ran with infer=False (raw
        messages), and "memory" when the LLM extracted facts.
    """
    items = search_result
    if isinstance(search_result, dict):
        items = search_result.get("results", search_result.get("memories", []))
    if not isinstance(items, list):
        return []
    texts = []
    for item in items:
        if not isinstance(item, dict):
            continue
        text = item.get("memory") or item.get("data") or item.get("text") or ""
        text = str(text).strip()
        if text:
            texts.append(text)
    return texts


def _get_all(client, user_id: str):
    """get_all() has the same top-level-vs-filters split as search()."""
    try:
        return client.get_all(filters={"user_id": user_id})
    except TypeError:
        return client.get_all(user_id=user_id)
    except ValueError as e:
        if "filters" in str(e) or "Top-level entity" in str(e):
            return client.get_all(user_id=user_id)
        raise


# ── Auth middleware (simple API key) ───────────────────────────────────────
def resolve_api_key(
    api_key: Optional[str] = None,
    authorization: Optional[str] = None,
    x_api_key: Optional[str] = None,
) -> Optional[str]:
    """Accept the key from an Authorization header, an X-API-Key header, or the
    legacy ?api_key= query parameter.

    OmniRoute's sidecar client (open-sse/services/sidecars.ts) sends
    `Authorization: Bearer <key>`, but every route here declared `api_key` as a
    bare scalar, which FastAPI binds as a QUERY parameter. The header was
    therefore never read, api_key was always None, and every call 401'd —
    compactContext() swallowed that and silently fell back to client-side
    truncation, so context compaction never actually ran server-side.
    """
    if authorization:
        token = authorization.strip()
        if token.lower().startswith("bearer "):
            token = token[7:].strip()
        if token:
            return token
    if x_api_key:
        return x_api_key.strip()
    return api_key


def check_auth(api_key: Optional[str]):
    if API_KEY and api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


# ── Models ─────────────────────────────────────────────────────────────────
class AddMemoryRequest(BaseModel):
    messages: list
    user_id: str = "default"
    metadata: dict = {}


class SearchMemoryRequest(BaseModel):
    query: str
    user_id: str = "default"
    limit: int = 10


class CompactContextRequest(BaseModel):
    messages: list
    user_id: str = "default"
    max_tokens: int = 4000


# ── Routes ─────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    """Report backing-service wiring so a stub is diagnosable without shell access.

    The previous form returned a bare {"mem0": "stub"} with no indication of
    which dependency was missing, which is how this service ran as a stub in
    production unnoticed.
    """
    client = get_mem0()
    return {
        "status": "ok",
        "mem0": "connected" if client else "stub",
        "vector_store": "pgvector",
        "embedder": {"provider": EMBEDDER_PROVIDER, "model": EMBEDDER_MODEL, "dims": EMBEDDING_DIMS},
        "llm": {"model": LLM_MODEL, "base_url": LLM_BASE_URL or "openai"},
        "infer_on_add": INFER_ON_ADD,
        "postgres_configured": bool(os.getenv("POSTGRES_HOST")),
        "last_init_error": _last_init_error,
    }


@app.post("/memories/add")
async def add_memory(req: AddMemoryRequest, api_key: Optional[str] = None,
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    check_auth(resolve_api_key(api_key, authorization, x_api_key))
    client = get_mem0()
    if client is None:
        return {"status": "stub", "message": "Mem0 not configured — request accepted but no memory stored"}
    try:
        result = client.add(
            messages=req.messages,
            user_id=req.user_id,
            metadata=req.metadata,
        )
        return {"status": "ok", "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/memories/search")
async def search_memory(req: SearchMemoryRequest, api_key: Optional[str] = None,
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    check_auth(resolve_api_key(api_key, authorization, x_api_key))
    client = get_mem0()
    if client is None:
        return {"status": "stub", "memories": []}
    try:
        results = _search(client, req.query, req.user_id, req.limit)
        return {"status": "ok", "memories": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/context/compact")
async def compact_context(
    req: CompactContextRequest,
    api_key: Optional[str] = None,
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    """Compact a long conversation history into a concise summary using mem0."""
    check_auth(resolve_api_key(api_key, authorization, x_api_key))
    client = get_mem0()
    if client is None:
        # Fallback: simple truncation
        total_chars = sum(len(str(m.get("content", ""))) for m in req.messages)
        if total_chars <= req.max_tokens * 4:
            return {"status": "ok", "compacted": False, "messages": req.messages}
        # Keep first 2 and last N messages
        kept = req.messages[:2] + req.messages[-6:]
        return {"status": "ok", "compacted": True, "messages": kept, "method": "truncation"}
    try:
        # Store the conversation, then retrieve what is relevant to the latest turn.
        # infer=False skips LLM fact-extraction, which is by far the slowest step
        # here and sits on the hot path of every compaction — a long-context
        # request would otherwise pay a full extraction pass over the entire
        # history before the caller's 30s sidecar timeout. Opt in via
        # MEM0_INFER_ON_ADD=true once extraction latency is acceptable.
        client.add(messages=req.messages, user_id=req.user_id, infer=INFER_ON_ADD)
        # Search for the most relevant memories to build a compact context
        last_user_msg = ""
        for m in reversed(req.messages):
            if m.get("role") == "user":
                last_user_msg = str(m.get("content", ""))[:500]
                break
        if last_user_msg:
            relevant = _search(client, last_user_msg, req.user_id, 5)
            summary = "\n".join(f"- {t}" for t in _memory_texts(relevant))
            if summary:
                compact_messages = [
                    {"role": "system", "content": f"Relevant context from memory:\n{summary}"},
                ] + req.messages[-4:]
                return {"status": "ok", "compacted": True, "messages": compact_messages, "method": "mem0"}
        return {"status": "ok", "compacted": False, "messages": req.messages}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/memories")
async def list_memories(user_id: str = "default", api_key: Optional[str] = None,
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    check_auth(resolve_api_key(api_key, authorization, x_api_key))
    client = get_mem0()
    if client is None:
        return {"status": "stub", "memories": []}
    try:
        memories = _get_all(client, user_id)
        return {"status": "ok", "memories": memories}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/memories")
async def delete_memory(memory_id: str, api_key: Optional[str] = None,
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    check_auth(resolve_api_key(api_key, authorization, x_api_key))
    client = get_mem0()
    if client is None:
        return {"status": "stub", "deleted": False}
    try:
        client.delete(memory_id=memory_id)
        return {"status": "ok", "deleted": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8080)))
