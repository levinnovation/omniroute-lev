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

# ── Mem0 client (lazy init) ────────────────────────────────────────────────
_mem0_client = None

def get_mem0():
    global _mem0_client
    if _mem0_client is not None:
        return _mem0_client
    try:
        from mem0 import Memory
        config = {
            "vector_store": {
                "provider": "pgvector",
                "config": {
                    "dbname": os.getenv("POSTGRES_DB", "postgres"),
                    "collection_name": "mem0_memories",
                    "host": os.getenv("POSTGRES_HOST", "localhost"),
                    "port": int(os.getenv("POSTGRES_PORT", "5432")),
                    "user": os.getenv("POSTGRES_USER", "postgres"),
                    "password": os.getenv("POSTGRES_PASSWORD", ""),
                },
            },
        }
        if OPENAI_API_KEY:
            config["llm"] = {
                "provider": "openai",
                "config": {"api_key": OPENAI_API_KEY, "model": "gpt-4o-mini"},
            }
            config["embedder"] = {
                "provider": "openai",
                "config": {"api_key": OPENAI_API_KEY, "model": "text-embedding-3-small"},
            }
        _mem0_client = Memory.from_config(config)
        logger.info("Mem0 initialized with pgvector backend")
    except Exception as e:
        logger.warning(f"Mem0 init failed (running in stub mode): {e}")
        _mem0_client = None
    return _mem0_client


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
    return {"status": "ok", "mem0": "connected" if get_mem0() else "stub"}


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
        results = client.search(
            query=req.query,
            user_id=req.user_id,
            limit=req.limit,
        )
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
        # Use mem0 to extract and store relevant memories, then return a compact context
        client.add(messages=req.messages, user_id=req.user_id)
        # Search for the most relevant memories to build a compact context
        last_user_msg = ""
        for m in reversed(req.messages):
            if m.get("role") == "user":
                last_user_msg = str(m.get("content", ""))[:500]
                break
        if last_user_msg:
            relevant = client.search(query=last_user_msg, user_id=req.user_id, limit=5)
            summary = "\n".join(f"- {m.get('memory', '')}" for m in relevant if isinstance(m, dict))
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
        memories = client.get_all(user_id=user_id)
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
