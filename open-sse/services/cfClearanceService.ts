/**
 * cfClearanceService.ts — Shared TypeScript client for the Python
 * cloudflare-solver Railway sidecar.
 *
 * Provides a unified `getCfClearance()` function that any web-cookie
 * provider can call to acquire a fresh `cf_clearance` cookie for a
 * Cloudflare-protected URL. Results are cached in-memory with a 50-minute
 * TTL (5-minute buffer before cf_clearance's ~1 hour expiry).
 *
 * The Python sidecar must be deployed on the same Railway private network
 * as OmniRoute so the cf_clearance cookie is valid for OmniRoute's egress IP.
 *
 * Configuration:
 *   OMNIROUTE_CFSOLVER_URL — Base URL of the Python cloudflare-solver sidecar
 *                            (e.g., http://cloudflare-solver.railway.internal:8080)
 *
 * If the sidecar is not configured or unreachable, getCfClearance() returns
 * null — callers should fall back to provider-specific solvers
 * (grokClearance.ts, claudeTurnstileSolver.ts) or return an error.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export interface CfClearanceResult {
  cfClearance: string;
  userAgent: string;
  cookies: Record<string, string>;
  expiresAt: number; // Unix timestamp (ms)
}

interface CacheEntry {
  result: CfClearanceResult;
  expiresAt: number; // ms timestamp
}

// ── Configuration ─────────────────────────────────────────────────────────

function getCfSolverUrl(): string | null {
  const url = process.env.OMNIROUTE_CFSOLVER_URL;
  if (!url) return null;
  return url.replace(/\/+$/, ""); // strip trailing slash
}

// ── Cache ─────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 50 * 60 * 1000; // 50 minutes (5 min buffer before 1h expiry)
const cache = new Map<string, CacheEntry>();

// ── Test injection ────────────────────────────────────────────────────────

type CfClearanceFn = (url: string, userAgent?: string) => Promise<CfClearanceResult | null>;

let acquireOverride: CfClearanceFn | null = null;

export function __setCfClearanceAcquireOverrideForTesting(fn: CfClearanceFn | null): void {
  acquireOverride = fn;
}

export function __clearCfClearanceCacheForTesting(): void {
  cache.clear();
}

// ── Core API ──────────────────────────────────────────────────────────────

/**
 * Acquire a fresh cf_clearance cookie for a Cloudflare-protected URL.
 *
 * Uses an in-memory cache to avoid re-solving for the same URL within
 * the cache TTL (50 minutes). If the sidecar is not configured or
 * unreachable, returns null — callers should handle the fallback.
 *
 * @param url - The Cloudflare-protected URL (e.g., "https://grok.com/")
 * @param userAgent - Optional User-Agent to use (must match the UA that
 *                    will be used in subsequent requests, since cf_clearance
 *                    is UA-pinned)
 * @returns CfClearanceResult with the cookie, or null on failure
 */
export async function getCfClearance(
  url: string,
  userAgent?: string
): Promise<CfClearanceResult | null> {
  // Check cache first
  const cacheKey = `${url}::${userAgent ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  // Test override
  if (acquireOverride) {
    const result = await acquireOverride(url, userAgent);
    if (result) {
      cache.set(cacheKey, {
        result,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }
    return result;
  }

  // Call the Python sidecar
  const solverUrl = getCfSolverUrl();
  if (!solverUrl) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000); // 60s max

    const response = await fetch(`${solverUrl}/cf-clearance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, user_agent: userAgent }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[cfClearanceService] Sidecar returned ${response.status} for ${url}`);
      return null;
    }

    const data = (await response.json()) as {
      cf_clearance: string;
      user_agent: string;
      cookies: Record<string, string>;
      expires_at: number;
    };

    if (!data.cf_clearance) {
      console.warn(`[cfClearanceService] Sidecar returned empty cf_clearance for ${url}`);
      return null;
    }

    const result: CfClearanceResult = {
      cfClearance: data.cf_clearance,
      userAgent: data.user_agent,
      cookies: data.cookies ?? {},
      expiresAt: data.expires_at * 1000, // Convert to ms
    };

    // Cache the result
    cache.set(cacheKey, {
      result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    console.log(
      `[cfClearanceService] Acquired cf_clearance for ${url} (length: ${result.cfClearance.length})`
    );

    return result;
  } catch (err) {
    console.warn(
      `[cfClearanceService] Failed to acquire cf_clearance for ${url}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Inject a cf_clearance cookie into a cookie string, replacing any
 * existing cf_clearance value. If the cookie string doesn't contain
 * cf_clearance, the new cookie is appended.
 *
 * @param cookieString - The existing cookie header value
 * @param cfClearance - The cf_clearance cookie value
 * @returns Updated cookie string with the new cf_clearance
 */
export function injectCfClearance(cookieString: string, cfClearance: string): string {
  const cfCookie = `cf_clearance=${cfClearance}`;
  if (/(?:^|;\s*)cf_clearance=/.test(cookieString)) {
    return cookieString.replace(/cf_clearance=[^;]*/, cfCookie);
  }
  return cookieString ? `${cookieString}; ${cfCookie}` : cfCookie;
}

/**
 * Clear the cache for a specific URL (useful when a cf_clearance is
 * known to be invalid — e.g., 403 after using it).
 */
export function invalidateCfClearance(url: string, userAgent?: string): void {
  const cacheKey = `${url}::${userAgent ?? ""}`;
  cache.delete(cacheKey);
}

/**
 * Check if the cloudflare-solver sidecar is configured.
 */
export function isCfSolverConfigured(): boolean {
  return getCfSolverUrl() !== null;
}
