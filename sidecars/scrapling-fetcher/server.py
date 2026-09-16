"""
Scrapling Fetcher Sidecar — FastAPI REST wrapper around curl_cffi.

Provides browser TLS fingerprint impersonation for HTTP requests. Used by
OmniRoute's direct-HTTP fallback path when a provider's WAF (Cloudflare,
DataDome) blocks plain Node.js fetch.

curl_cffi impersonates the TLS fingerprint (JA3/JA4) of real browsers,
making requests appear to come from Chrome, Firefox, or Safari at the
network layer. This bypasses WAF fingerprint checks without needing a
full browser.

Endpoints:
  POST /fetch   — Proxy an HTTP request with browser fingerprint impersonation
  GET  /health  — Health check

Authentication:
  Set SCRAPLING_API_KEY env var. Clients pass it via the X-Scrapling-Key
  header. When SCRAPLING_API_KEY is unset, auth is disabled (dev only).
"""

import os
import time
import logging
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from curl_cffi import requests as curl_requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s [scrapling] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Scrapling Fetcher Sidecar", version="1.0.0")

# Auth: when SCRAPLING_API_KEY is set, requests must carry it in X-Scrapling-Key.
_API_KEY = os.environ.get("SCRAPLING_API_KEY", "")

# Maximum body size we accept (1 MB). Provider chat requests are small;
# larger bodies are likely a mistake or abuse.
MAX_BODY_BYTES = 1_048_576

# Request timeout (seconds). Bounded so a hung provider doesn't hold a
# worker indefinitely.
DEFAULT_TIMEOUT = 30


class FetchRequest(BaseModel):
    url: str = Field(..., description="The URL to fetch")
    method: str = Field("GET", description="HTTP method (GET, POST, PUT, DELETE, etc.)")
    headers: dict = Field(default_factory=dict, description="Request headers")
    body: Optional[str] = Field(None, description="Request body (string)")
    impersonate: str = Field(
        "chrome131",
        description=(
            "Browser to impersonate for TLS fingerprint. "
            "Options: chrome131, chrome124, chrome120, chrome116, "
            "chrome110, chrome107, chrome104, chrome101, chrome100, "
            "chrome99, chrome96, chrome95, chrome94, chrome91, chrome90, "
            "chrome89, chrome88, chrome87, chrome86, chrome84, chrome83, "
            "chrome81, chrome80, chrome79, chrome78, chrome77, chrome76, "
            "chrome75, chrome74, chrome73, chrome72, chrome71, chrome70, "
            "chrome69, chrome68, chrome67, chrome66, chrome65, chrome64, "
            "chrome63, chrome62, chrome61, chrome60, firefox133, firefox120, "
            "firefox117, firefox111, firefox108, firefox107, firefox105, "
            "firefox104, firefox102, firefox101, firefox100, firefox99, "
            "firefox98, firefox96, firefox95, firefox94, firefox92, firefox91, "
            "firefox90, firefox89, firefox88, firefox87, firefox86, firefox85, "
            "firefox84, firefox83, firefox82, firefox80, firefox79, firefox78, "
            "firefox77, firefox76, firefox75, firefox74, firefox73, firefox72, "
            "firefox68, safari17_0, safari16_5, safari16_0, safari15_6, "
            "safari15_3, safari15_0, safari14_1, safari13_1, safari12_1"
        ),
    )
    timeout: int = Field(DEFAULT_TIMEOUT, description="Request timeout in seconds", ge=1, le=120)


class FetchResponse(BaseModel):
    status: int
    headers: dict
    body: str
    content_type: str
    elapsed_ms: int


def _check_auth(x_scrapling_key: Optional[str]) -> None:
    """Verify the request carries the correct API key when auth is enabled."""
    if not _API_KEY:
        return  # auth disabled (dev mode)
    if x_scrapling_key != _API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized: invalid or missing API key")


@app.on_event("startup")
async def startup():
    logger.info("Scrapling Fetcher Sidecar starting up")
    if _API_KEY:
        logger.info("API key authentication enabled")
    else:
        logger.warning("SCRAPLING_API_KEY not set — authentication disabled (dev mode)")


@app.on_event("shutdown")
async def shutdown():
    logger.info("Scrapling Fetcher Sidecar shut down")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "scrapling-fetcher", "version": "1.0.0"}


@app.post("/fetch", response_model=FetchResponse)
async def fetch(
    req: FetchRequest,
    x_scrapling_key: Optional[str] = Header(None, alias="X-Scrapling-Key"),
):
    """
    Proxy an HTTP request through curl_cffi with browser TLS fingerprint
    impersonation.

    The request is sent using the impersonated browser's TLS fingerprint,
    making it appear to come from a real browser at the network layer.
    This bypasses WAF fingerprint checks (Cloudflare, DataDome) that block
    plain Node.js fetch.
    """
    _check_auth(x_scrapling_key)

    # Validate body size
    if req.body and len(req.body.encode("utf-8")) > MAX_BODY_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Request body too large (max {MAX_BODY_BYTES} bytes)",
        )

    method = req.method.upper()
    start = time.monotonic()

    try:
        logger.info(f"Fetching {method} {req.url} (impersonate={req.impersonate})")

        response = curl_requests.request(
            method=method,
            url=req.url,
            headers=req.headers,
            data=req.body,
            impersonate=req.impersonate,
            timeout=req.timeout,
            allow_redirects=True,
        )

        elapsed_ms = int((time.monotonic() - start) * 1000)

        # Extract headers (curl_cffi returns a Headers-like object)
        resp_headers = {}
        try:
            for key, value in response.headers.items():
                resp_headers[key.lower()] = value
        except Exception:
            pass

        content_type = resp_headers.get("content-type", "application/octet-stream")

        # Read body as text
        try:
            body_text = response.text
        except Exception:
            body_text = response.content.decode("utf-8", errors="replace")

        logger.info(
            f"Fetched {method} {req.url} → {response.status_code} "
            f"({elapsed_ms}ms, {len(body_text)} bytes)"
        )

        return FetchResponse(
            status=response.status_code,
            headers=resp_headers,
            body=body_text,
            content_type=content_type,
            elapsed_ms=elapsed_ms,
        )

    except Exception as e:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        logger.error(f"Fetch failed for {method} {req.url} ({elapsed_ms}ms): {e}")
        raise HTTPException(status_code=502, detail=f"Fetch failed: {str(e)}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)
