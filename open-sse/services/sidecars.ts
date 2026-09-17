// LEV fork: Sidecar service integration for OmniRoute.
//
// Connects to six Railway sidecar services:
//   1. Browserless — external browser pool for web-cookie providers
//   2. LiteLLM — API-key provider router
//   3. Mem0 — context/memory compaction service
//   4. Cloudflare-Solver — Python sidecar for cf_clearance acquisition
//   5. Scrapling-Fetcher — Python sidecar for browser TLS fingerprint impersonation
//   6. CrewAI-Coder — Python sidecar for agentic coding (CrewAI flow)
//
// Each sidecar has a health check and graceful fallback if unavailable.

export interface SidecarConfig {
  url: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface SidecarHealth {
  name: string;
  url: string;
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

// ── Configuration from environment ─────────────────────────────────────────

export function getBrowserlessConfig(): SidecarConfig | null {
  const url = process.env.OMNIROUTE_BROWSERLESS_URL;
  if (!url) return null;
  return {
    url,
    apiKey: process.env.OMNIROUTE_BROWSERLESS_TOKEN || undefined,
    timeoutMs: 30000,
  };
}

export function getLiteLLMConfig(): SidecarConfig | null {
  const url = process.env.OMNIROUTE_LITELLM_URL;
  if (!url) return null;
  return {
    url,
    apiKey: process.env.OMNIROUTE_LITELLM_KEY || undefined,
    timeoutMs: 120000,
  };
}

export function getMem0Config(): SidecarConfig | null {
  const url = process.env.OMNIROUTE_MEM0_URL;
  if (!url) return null;
  return {
    url,
    apiKey: process.env.OMNIROUTE_MEM0_KEY || undefined,
    // Real compaction embeds every message locally (sentence-transformers on
    // CPU) and then runs a pgvector similarity search, so it is meaningfully
    // slower than the stub that used to answer instantly. Blowing this deadline
    // is silent — compactContext() falls back to positional truncation — so it
    // is generous, and overridable without a redeploy.
    timeoutMs: Number(process.env.OMNIROUTE_MEM0_TIMEOUT_MS) || 60_000,
  };
}

export function getCfSolverConfig(): SidecarConfig | null {
  const url = process.env.OMNIROUTE_CFSOLVER_URL;
  if (!url) return null;
  return {
    url,
    apiKey: process.env.OMNIROUTE_CFSOLVER_KEY || undefined,
    timeoutMs: 60000, // 60s — Cloudflare challenges can take time to solve
  };
}

// LEV fork Phase 3: Scrapling fetcher sidecar — browser TLS fingerprint
// impersonation for direct-HTTP fallback when WAFs block plain fetch.
export function getScraplingConfig(): SidecarConfig | null {
  const url = process.env.OMNIROUTE_SCRAPLING_URL;
  if (!url) return null;
  return {
    url,
    apiKey: process.env.OMNIROUTE_SCRAPLING_KEY || undefined,
    timeoutMs: 30000, // 30s — HTTP proxy with fingerprint impersonation
  };
}

// LEV fork Phase 4: CrewAI coding sidecar — agentic coding service.
// Receives "agentic/" prefixed model requests, runs a CrewAI flow that
// uses OmniRoute as its LLM backend, and returns the coding result.
export function getCrewAIConfig(): SidecarConfig | null {
  const url = process.env.OMNIROUTE_CREWAI_URL;
  if (!url) return null;
  return {
    url,
    apiKey: process.env.OMNIROUTE_CREWAI_KEY || undefined,
    // 360s — coding runs use max_execution_time=300s on the sidecar; the
    // delegate timeout must exceed it or long agentic runs get cut off.
    timeoutMs: Number(process.env.OMNIROUTE_CREWAI_TIMEOUT_MS) || 360_000,
  };
}

// ── Health checks ──────────────────────────────────────────────────────────

// Each sidecar has a different health endpoint.
const SIDECAR_HEALTH_PATHS: Record<string, string> = {
  browserless: "/config",
  litellm: "/health/liveness",
  mem0: "/health",
  cfsolver: "/health",
  scrapling: "/health",
  crewai: "/health",
};

async function checkSidecarHealth(name: string, config: SidecarConfig): Promise<SidecarHealth> {
  const start = Date.now();
  const healthPath = SIDECAR_HEALTH_PATHS[name] ?? "/health";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10000);
    const baseUrl = `${config.url}${healthPath}`;
    const headers: Record<string, string> = {};
    if (config.apiKey && name !== "browserless") {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }
    const url =
      name === "browserless" && config.apiKey ? `${baseUrl}?token=${config.apiKey}` : baseUrl;
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeout);
    const latencyMs = Date.now() - start;
    return {
      name,
      url: config.url,
      healthy: response.ok,
      latencyMs,
    };
  } catch {
    return {
      name,
      url: config.url,
      healthy: false,
      latencyMs: Date.now() - start,
      error: "unreachable",
    };
  }
}

export async function checkAllSidecars(): Promise<SidecarHealth[]> {
  const checks: Promise<SidecarHealth>[] = [];
  const browserless = getBrowserlessConfig();
  if (browserless) checks.push(checkSidecarHealth("browserless", browserless));
  const litellm = getLiteLLMConfig();
  if (litellm) checks.push(checkSidecarHealth("litellm", litellm));
  const mem0 = getMem0Config();
  if (mem0) checks.push(checkSidecarHealth("mem0", mem0));
  const cfsolver = getCfSolverConfig();
  if (cfsolver) checks.push(checkSidecarHealth("cfsolver", cfsolver));
  const scrapling = getScraplingConfig();
  if (scrapling) checks.push(checkSidecarHealth("scrapling", scrapling));
  const crewai = getCrewAIConfig();
  if (crewai) checks.push(checkSidecarHealth("crewai", crewai));
  return Promise.all(checks);
}

// ── Mem0 context compaction ────────────────────────────────────────────────

export interface CompactContextRequest {
  messages: Array<{ role: string; content: string }>;
  userId: string;
  maxTokens?: number;
}

export interface CompactContextResult {
  compacted: boolean;
  messages: Array<{ role: string; content: string }>;
  method: string;
}

/**
 * Compact a long conversation context using the Mem0 sidecar.
 * Falls back to simple truncation if Mem0 is unavailable.
 */
export async function compactContext(
  messages: Array<{ role: string; content: string }>,
  userId: string = "default",
  maxTokens: number = 4000
): Promise<CompactContextResult> {
  const config = getMem0Config();
  if (!config) {
    // Fallback: simple truncation
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    if (totalChars <= maxTokens * 4) {
      return { compacted: false, messages, method: "none" };
    }
    const kept = messages.slice(0, 2).concat(messages.slice(-6));
    return { compacted: true, messages: kept, method: "truncation" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30000);
    const response = await fetch(`${config.url}/context/compact`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ messages, user_id: userId, max_tokens: maxTokens }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`Mem0 returned ${response.status}`);
    }
    const result = await response.json();
    return {
      compacted: result.compacted,
      messages: result.messages,
      method: result.method || "mem0",
    };
  } catch (err) {
    // Fallback to positional truncation. This path is a real degradation — it
    // keeps the first 2 and last 6 messages and throws the middle away with no
    // regard for relevance — so say so. Swallowing it silently is exactly how a
    // 401 from the sidecar went unnoticed in production while every large
    // request quietly lost its context.
    console.warn(
      `[Mem0] compactContext falling back to positional truncation: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    if (totalChars <= maxTokens * 4) {
      return { compacted: false, messages, method: "none" };
    }
    const kept = messages.slice(0, 2).concat(messages.slice(-6));
    return { compacted: true, messages: kept, method: "truncation-fallback" };
  }
}

// ── Browserless integration ────────────────────────────────────────────────

/**
 * Get a Browserless WebSocket endpoint URL for launching a browser session.
 * Returns null if Browserless is not configured.
 */
export function getBrowserlessWsUrl(): string | null {
  const config = getBrowserlessConfig();
  if (!config) return null;
  // Convert HTTP(S) URL to WebSocket URL — preserve the scheme:
  // https:// → wss://, http:// → ws://. Internal Railway URLs are http://
  // so they must use ws:// (not wss://) to avoid SSL protocol errors.
  const wsUrl = config.url.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  const tokenParam = config.apiKey ? `?token=${config.apiKey}` : "";
  // Browserless v2: ghcr.io/browserless/chrome exposes the CDP WebSocket at
  // /chrome (not /chromium). connectOverCDP uses this endpoint.
  return `${wsUrl}/chrome${tokenParam}`;
}

// ── Scrapling fetcher integration ──────────────────────────────────────────

export interface ScraplingFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  impersonate?: string;
  timeoutMs?: number;
}

export interface ScraplingFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType: string;
  elapsedMs: number;
}

/**
 * LEV fork Phase 3: Proxy an HTTP request through the Scrapling sidecar
 * with browser TLS fingerprint impersonation. Used as a fallback when
 * direct-HTTP fetch is WAF-blocked (Cloudflare 403, DataDome challenge).
 *
 * Returns null when the sidecar is not configured or the request fails,
 * so callers can fall back to the existing direct-HTTP path.
 */
export async function fetchViaScrapling(
  request: ScraplingFetchRequest
): Promise<ScraplingFetchResult | null> {
  const config = getScraplingConfig();
  if (!config) return null;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    request.timeoutMs ?? config.timeoutMs ?? 30_000
  );

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiKey) headers["X-Scrapling-Key"] = config.apiKey;

    const response = await fetch(`${config.url}/fetch`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
        impersonate: request.impersonate ?? "chrome131",
        timeout: Math.ceil((request.timeoutMs ?? config.timeoutMs ?? 30_000) / 1000),
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(
        `[Scrapling] Sidecar returned ${response.status}: ${await response.text().catch(() => "")}`
      );
      return null;
    }

    const result = await response.json();
    return {
      status: result.status,
      headers: result.headers,
      body: result.body,
      contentType: result.content_type,
      elapsedMs: result.elapsed_ms,
    };
  } catch (err) {
    clearTimeout(timeout);
    console.warn(`[Scrapling] Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * LEV fork Phase 3: Detect whether an HTTP error response indicates a WAF
 * block that the Scrapling sidecar could bypass. Returns true for Cloudflare
 * and DataDome challenge responses.
 */
export function isWafBlocked(
  status: number,
  headers: Record<string, string>,
  body: string
): boolean {
  if (status === 403) {
    // Cloudflare challenge page
    if (headers["server"]?.toLowerCase().includes("cloudflare")) return true;
    if (body.includes("cf-challenge") || body.includes("cf-ray")) return true;
    // DataDome challenge
    if (headers["x-datadome"]) return true;
    if (body.includes("datadome") || body.includes("DataDome")) return true;
    // Generic WAF block
    if (body.includes("Access denied") && body.includes("security")) return true;
  }
  if (status === 429 && headers["server"]?.toLowerCase().includes("cloudflare")) {
    return true;
  }
  return false;
}
