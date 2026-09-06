# ── Cloudflare Solver Sidecar ──────────────────────────────────────────────
#
# Playwright-based Cloudflare cf_clearance solver for the OmniRoute LEV fork.
# Navigates a Cloudflare-protected URL in a real headless Chromium, waits for
# the JS interstitial to clear, and returns the cf_clearance cookie.
#
# Deploy as a Railway service on the same private network as OmniRoute.
# OmniRoute calls it via OMNIROUTE_CFSOLVER_URL env var.
#
# Build: docker build -t cloudflare-solver sidecars/cloudflare-solver/
# Run:   docker run -p 8080:8080 cloudflare-solver

# Microsoft's official Playwright image ships Chromium plus every system
# library it needs, already matched to the Playwright version. Building on
# python:3.12-slim instead fails: that base is Debian trixie, which
# `playwright install --with-deps` does not support —
#   "BEWARE: your OS is not officially supported by Playwright; installing
#    dependencies for ubuntu20.04-x64 as a fallback"
# followed by a non-zero exit. Keep this tag in lockstep with the playwright
# pin in requirements.txt.
FROM mcr.microsoft.com/playwright/python:v1.49.1-jammy

WORKDIR /app

# curl is used by the HEALTHCHECK below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# Install Python dependencies. The browser itself is already in the base image,
# so no `playwright install` step is needed.
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
