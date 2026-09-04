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

# Install system dependencies for Chrome/Chromium
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    wget gnupg2 unzip curl \
    chromium \
    chromium-driver \
  && rm -rf /var/lib/apt/lists/*

# Set Chrome environment
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMEDRIVER_PATH=/usr/bin/chromedriver

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy server code
COPY server.py .

# Expose the REST API port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Run the FastAPI server
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
