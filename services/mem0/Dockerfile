# Mem0 context/memory compaction service for OmniRoute-LEV.
# Lightweight FastAPI server wrapping the mem0ai Python package.
# Uses the existing Postgres+pgvector for storage.
FROM python:3.12-slim

WORKDIR /app

# Install system deps for building Python packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl && \
    rm -rf /var/lib/apt/lists/*

# Install mem0 + FastAPI + uvicorn.
# CPU-only torch: the default wheel pulls ~2GB of CUDA libraries that are dead
# weight on a Railway container with no GPU, and slow enough to push the build
# past its timeout. Installed first so the sentence-transformers dependency
# resolution below reuses it instead of fetching the CUDA build.
RUN pip install --no-cache-dir \
    --extra-index-url https://download.pytorch.org/whl/cpu \
    "torch>=2.2,<3"

RUN pip install --no-cache-dir \
    "mem0ai>=0.1.50" \
    "fastapi>=0.115.0" \
    "uvicorn[standard]>=0.30.0" \
    "psycopg2-binary>=2.9" \
    "pgvector>=0.3.0" \
    "sentence-transformers>=3.0"

# Bake the embedding model into the image. Without this the first request pays a
# cold HuggingFace download, and a container with no outbound HF access would
# fall back to stub mode at runtime instead of at build time.
ENV MEM0_EMBEDDER_MODEL=all-MiniLM-L6-v2
ENV HF_HOME=/app/.cache/huggingface
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

# Copy the server code
COPY mem0_server.py .

ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["uvicorn", "mem0_server:app", "--host", "0.0.0.0", "--port", "8080"]
