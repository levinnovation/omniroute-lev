"""
Cloudflare Solver Sidecar — FastAPI REST wrapper around cloudflare-solver.

Provides a REST API for acquiring cf_clearance cookies for any
Cloudflare-protected URL. Designed to run as a Railway sidecar service
on the same private network as OmniRoute.

Endpoints:
  POST /cf-clearance  — Acquire a fresh cf_clearance cookie for a URL
  GET  /health        — Health check
"""

import time
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# cloudflare-solver is imported lazily so the server can start even if
# the browser binary is not yet installed (health check still works).
_solver = None
_solver_lock = None  # asyncio.Lock created on first use

logging.basicConfig(level=logging.INFO, format="%(asctime)s [cfsolver] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Cloudflare Solver Sidecar", version="1.0.0")


class CfClearanceRequest(BaseModel):
    url: str = Field(..., description="The Cloudflare-protected URL to get cf_clearance for")
    user_agent: Optional[str] = Field(None, description="Optional User-Agent to use")
    proxy: Optional[str] = Field(None, description="Optional proxy URL (http://host:port)")


class CfClearanceResponse(BaseModel):
    cf_clearance: str
    user_agent: str
    cookies: dict
    expires_at: int  # Unix timestamp


async def _get_solver():
    """Lazily initialize the cloudflare-solver instance."""
    global _solver, _solver_lock
    if _solver is None:
        import asyncio
        _solver_lock = asyncio.Lock()
        from cloudflare_solver import CloudflareSolver
        _solver = CloudflareSolver(headless=True)
        logger.info("CloudflareSolver initialized")
    return _solver, _solver_lock


@app.on_event("startup")
async def startup():
    logger.info("Cloudflare Solver Sidecar starting up")


@app.on_event("shutdown")
async def shutdown():
    global _solver
    if _solver is not None:
        try:
            await _solver.close()
        except Exception:
            pass
    logger.info("Cloudflare Solver Sidecar shut down")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "cloudflare-solver", "version": "1.0.0"}


@app.post("/cf-clearance", response_model=CfClearanceResponse)
async def get_cf_clearance(req: CfClearanceRequest):
    """
    Acquire a fresh cf_clearance cookie for the given URL.

    The solver launches a real browser (undetected-chromedriver), navigates
    to the URL, waits for the Cloudflare challenge to auto-solve, and
    extracts the cf_clearance cookie.

    cf_clearance is IP+UA+TLS pinned — the cookie is only valid from the
    same egress IP that earned it. This sidecar must run on the same
    Railway private network as OmniRoute.
    """
    import asyncio

    solver, lock = await _get_solver()

    async with lock:
        try:
            logger.info(f"Solving cf_clearance for URL: {req.url}")

            # cloudflare-solver API: solve(url, user_agent, proxy)
            kwargs = {}
            if req.user_agent:
                kwargs["user_agent"] = req.user_agent
            if req.proxy:
                kwargs["proxy"] = req.proxy

            result = await solver.solve(req.url, **kwargs)

            if not result or not result.get("cf_clearance"):
                raise HTTPException(
                    status_code=502,
                    detail="Failed to acquire cf_clearance — challenge may not have solved",
                )

            # cf_clearance typically expires in ~1 hour; use 55 min as safe TTL
            expires_at = int(time.time()) + 3300

            logger.info(
                f"cf_clearance acquired for {req.url} "
                f"(cookie length: {len(result['cf_clearance'])}, expires in ~55min)"
            )

            return CfClearanceResponse(
                cf_clearance=result["cf_clearance"],
                user_agent=result.get("user_agent", req.user_agent or ""),
                cookies=result.get("cookies", {}),
                expires_at=expires_at,
            )

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"cf_clearance solving failed for {req.url}: {e}")
            raise HTTPException(status_code=502, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
