# ── Scrapling Fetcher Sidecar ──────────────────────────────────────────────
#
# Python FastAPI sidecar that proxies HTTP requests through curl_cffi with
# browser TLS fingerprint impersonation. Used by OmniRoute's direct-HTTP
# fallback path when a provider's WAF (Cloudflare, DataDome) blocks plain
# Node.js fetch.
#
# Deploy as a Railway service on the same private network as OmniRoute.
# OmniRoute calls it via OMNIROUTE_SCRAPLING_URL env var.
#
# Build: docker build -t scrapling-fetcher sidecars/scrapling-fetcher/
# Run:   docker run -p 8080:8080 scrapling-fetcher

FROM python:3.12-slim

WORKDIR /app

# curl is used by the HEALTHCHECK below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# Install Python dependencies.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy server code
COPY server.py .

# Expose the REST API port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Run the FastAPI server
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
