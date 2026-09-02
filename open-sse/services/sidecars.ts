// LEV fork: Sidecar service integration for OmniRoute.
//
// Connects to three Railway sidecar services:
//   1. Browserless — external browser pool for web-cookie providers
//   2. LiteLLM — API-key provider router
//   3. Mem0 — context/memory compaction service
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
    timeoutMs: 30000,
  };
}

// ── Health checks ──────────────────────────────────────────────────────────

// Each sidecar has a different health endpoint.
const SIDECAR_HEALTH_PATHS: Record<string, string> = {
  browserless: "/config",
  litellm: "/health/liveness",
  mem0: "/health",
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
  } catch {
    // Fallback to truncation on error
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
  return `${wsUrl}/chromium${tokenParam}`;
}
