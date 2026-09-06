# ── Cloudflare Solver Sidecar ──────────────────────────────────────────────
#
# Python-based Cloudflare cf_clearance solver for OmniRoute LEV fork.
# Uses cloudflare-solver (undetected-chromedriver) to solve Cloudflare
# challenge pages and extract cf_clearance cookies.
#
# Deploy as a Railway service on the same private network as OmniRoute.
# OmniRoute calls it via OMNIROUTE_CFSOLVER_URL env var.
#
# Build: docker build -t cloudflare-solver sidecars/cloudflare-solver/
# Run:   docker run -p 8080:8080 cloudflare-solver

FROM python:3.12-slim

WORKDIR /app

# curl is needed for the HEALTHCHECK below; Chromium itself comes from
# `playwright install --with-deps`, which pins a browser build matched to the
# Playwright version instead of whatever Debian ships.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Chromium plus its system libraries. --with-deps pulls the exact apt
# packages the bundled build needs, so a missing shared object surfaces at build
# time rather than as a launch failure on the first solve request.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN playwright install --with-deps chromium

# Copy server code
COPY server.py .

# Expose the REST API port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Run the FastAPI server
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
