"""
Cloudflare Solver Sidecar — FastAPI REST wrapper around cloudflare-solver.

Provides a REST API for acquiring cf_clearance cookies for any
Cloudflare-protected URL. Designed to run as a Railway sidecar service
on the same private network as OmniRoute.

Endpoints:
  POST /cf-clearance  — Acquire a fresh cf_clearance cookie for a URL
  GET  /health        — Health check
"""

import asyncio
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


DEFAULT_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

# How long to wait for Cloudflare's interstitial to clear before giving up.
CHALLENGE_TIMEOUT_MS = 45_000


async def _get_solver():
    """Lazily start Playwright and keep one browser warm.

    Returns (browser, lock). The lock serialises solves: each one drives a real
    browser and Cloudflare rate-limits by IP anyway, so concurrency here buys
    nothing and costs memory.
    """
    global _solver, _solver_lock
    if _solver is None:
        import asyncio
        from playwright.async_api import async_playwright

        _solver_lock = asyncio.Lock()
        pw = await async_playwright().start()
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        _solver = {"pw": pw, "browser": browser}
        logger.info("Playwright chromium launched for cf_clearance solving")
    return _solver, _solver_lock


async def _solve_clearance(url: str, user_agent: str, proxy: Optional[str]) -> dict:
    """Navigate to a Cloudflare-protected URL and wait out the JS challenge.

    Returns {cf_clearance, user_agent, cookies}. cf_clearance is absent when the
    origin never issued one — either the challenge did not clear, or the URL was
    not actually challenged.
    """
    solver, _ = await _get_solver()
    browser = solver["browser"]

    context_kwargs: dict = {
        "user_agent": user_agent,
        "viewport": {"width": 1280, "height": 800},
        "locale": "en-US",
    }
    if proxy:
        context_kwargs["proxy"] = {"server": proxy}

    context = await browser.new_context(**context_kwargs)
    try:
        page = await context.new_page()
        # Hide the most obvious automation tell before any page script runs.
        await page.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
        )
        await page.goto(url, wait_until="domcontentloaded", timeout=CHALLENGE_TIMEOUT_MS)

        # Poll for the cookie rather than racing a fixed sleep: the interstitial
        # can clear in under a second or take tens of seconds under load.
        deadline = time.time() + (CHALLENGE_TIMEOUT_MS / 1000)
        while time.time() < deadline:
            cookies = await context.cookies()
            if any(c.get("name") == "cf_clearance" for c in cookies):
                break
            await asyncio.sleep(1.0)

        cookies = await context.cookies()
        jar = {c["name"]: c["value"] for c in cookies if "name" in c and "value" in c}
        return {
            "cf_clearance": jar.get("cf_clearance", ""),
            "user_agent": user_agent,
            "cookies": jar,
        }
    finally:
        await context.close()


@app.on_event("startup")
async def startup():
    logger.info("Cloudflare Solver Sidecar starting up")


@app.on_event("shutdown")
async def shutdown():
    global _solver
    if _solver is not None:
        try:
            await _solver["browser"].close()
            await _solver["pw"].stop()
        except Exception:
            pass
        _solver = None
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

    _, lock = await _get_solver()

    async with lock:
        try:
            logger.info(f"Solving cf_clearance for URL: {req.url}")

            result = await _solve_clearance(
                req.url, req.user_agent or DEFAULT_UA, req.proxy
            )

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
