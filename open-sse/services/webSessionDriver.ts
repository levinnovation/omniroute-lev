/**
 * WebSessionDriver — Unified lifecycle manager for cookie/token-based web providers.
 *
 * LEV fork addition. Replaces the ad-hoc per-executor session logic with a shared,
 * testable driver that all cookie-based web providers use.
 *
 * Responsibilities:
 *   1. Pre-dispatch session validation (refuse to route to dead sessions)
 *   2. Automatic cookie/token refresh where the provider supports it
 *   3. Empty-content failure detection (the #1 user-facing bug: silent 200 with null content)
 *   4. Stream watchdog (detect truncated/empty streams in real-time)
 *   5. Login-redirect detection (browser landed on auth wall, not chat)
 *   6. DOM-selector health checks (detect UI changes before they cause silent failures)
 *
 * Used by: zai-web, gemini-web, deepseek-web, huggingchat, claude-web executors.
 */

import { sanitizeErrorMessage } from "../utils/error.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WebSessionConfig {
  /** Provider identifier — e.g. "zai-web", "gemini-web" */
  providerId: string;
  /** URL to validate session health (lightweight GET, not a chat completion) */
  sessionProbeUrl: string;
  /** Build the auth headers for the session probe from the token/cookie */
  sessionProbeHeaders: (credential: string) => Record<string, string>;
  /** URL for token refresh (if the provider supports server-side refresh) */
  refreshUrl?: string;
  /** HTTP method for refresh (default GET) */
  refreshMethod?: "GET" | "POST";
  /** URL patterns that indicate the browser landed on a login wall */
  loginRedirectPatterns: RegExp[];
  /** Selectors that must be visible on the chat page for DOM health */
  domHealthSelectors: string[];
  /** Max time (ms) to wait for the first content token before declaring failure */
  streamWatchdogMs: number;
  /** Max retries on empty content before giving up (default 1) */
  emptyContentRetryMax: number;
  /** Cookie domain for browser-based providers */
  cookieDomain?: string;
  /** localStorage key for token-based providers (e.g. zai-web uses "token") */
  localStorageKey?: string;
  /** Origin for localStorage extraction */
  localStorageOrigin?: string;
}

export interface WebSessionHealth {
  connectionId: string;
  providerId: string;
  status: "healthy" | "expired" | "unknown";
  lastChecked: Date;
  lastError?: string;
  /** Estimated token expiry (if the provider exposes it) */
  tokenExpiryEstimate?: Date;
  /** Consecutive failures since last success */
  consecutiveFailures: number;
}

// ── In-memory session health cache ─────────────────────────────────────────
//
// Separate from credentialHealth/cache.ts — this is per-session, not per-connection,
// and updates in real-time from executor failures, not just from the background sweep.
// TTL is 60s: most requests skip the probe via this cache.

const SESSION_CACHE_TTL_MS = 60 * 1000; // 1 minute
const sessionHealthCache = new Map<string, { health: WebSessionHealth; expiresAt: number }>();

function getCachedHealth(connectionId: string): WebSessionHealth | undefined {
  const entry = sessionHealthCache.get(connectionId);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    sessionHealthCache.delete(connectionId);
    return undefined;
  }
  return entry.health;
}

function setCachedHealth(connectionId: string, health: WebSessionHealth): void {
  sessionHealthCache.set(connectionId, {
    health,
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
  });
}

/** Test-only: clear the session health cache. */
export function __clearSessionHealthCacheForTest(): void {
  sessionHealthCache.clear();
}

// ── The driver ─────────────────────────────────────────────────────────────

export class WebSessionDriver {
  constructor(private config: WebSessionConfig) {}

  // ── 1. Pre-dispatch session validation ──────────────────────────────────

  /**
   * Validate the session before dispatching to the browser transport.
   * Returns true if the session is healthy (or inconclusive), false if expired.
   *
   * Uses the in-memory cache for sub-ms lookups within the TTL window.
   * On 401/403, marks the session as expired and returns false so the executor
   * can return a proper 503 error instead of a silent 200 with empty content.
   */
  async validateSession(credential: string, connectionId: string): Promise<boolean> {
    // Check cache first (sub-ms)
    const cached = getCachedHealth(connectionId);
    if (cached) {
      if (cached.status === "expired") return false;
      if (cached.status === "healthy") return true;
      // unknown — fall through to probe
    }

    // Probe the session endpoint
    try {
      const response = await fetch(this.config.sessionProbeUrl, {
        method: "GET",
        headers: this.config.sessionProbeHeaders(credential),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 401 || response.status === 403) {
        await this.markExpired(connectionId, `Session probe returned HTTP ${response.status}`);
        return false;
      }

      if (response.status >= 200 && response.status < 300) {
        setCachedHealth(connectionId, {
          connectionId,
          providerId: this.config.providerId,
          status: "healthy",
          lastChecked: new Date(),
          consecutiveFailures: 0,
        });
        return true;
      }

      // 429, 503, etc. — inconclusive, allow the request
      // Don't update cache — let the next probe try again
      return true;
    } catch {
      // Network error — inconclusive, allow the request
      // Don't penalize the session for our own network issues
      return true;
    }
  }

  // ── 2. Mark session as expired ──────────────────────────────────────────

  /**
   * Mark a session as expired. Called by executors when they detect a failure
   * (empty content, login redirect, 401 from upstream).
   *
   * The credential health scheduler will pick this up on its next sweep and
   * update the connection's testStatus in the database.
   */
  async markExpired(connectionId: string, reason: string): Promise<void> {
    const prev = getCachedHealth(connectionId);
    setCachedHealth(connectionId, {
      connectionId,
      providerId: this.config.providerId,
      status: "expired",
      lastChecked: new Date(),
      lastError: reason,
      consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
    });
  }

  /**
   * Mark a session as healthy after a successful request.
   */
  markHealthy(connectionId: string): void {
    setCachedHealth(connectionId, {
      connectionId,
      providerId: this.config.providerId,
      status: "healthy",
      lastChecked: new Date(),
      consecutiveFailures: 0,
    });
  }

  // ── 3. Automatic cookie/token refresh ───────────────────────────────────

  /**
   * Attempt to refresh the session without user interaction.
   * Only works for providers that support server-side token refresh.
   * Returns the new credential string, or null if refresh is not supported/failed.
   */
  async refreshSession(credential: string): Promise<string | null> {
    if (!this.config.refreshUrl) return null;

    try {
      const response = await fetch(this.config.refreshUrl, {
        method: this.config.refreshMethod ?? "GET",
        headers: this.config.sessionProbeHeaders(credential),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) return null;

      // The response format depends on the provider — callers override this
      // for provider-specific parsing. Default: try to extract a token from JSON.
      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!data) return null;

      // Common patterns: { token: "..." } or { access_token: "..." }
      const newToken =
        (data.token as string | undefined) ?? (data.access_token as string | undefined);
      return newToken ?? null;
    } catch {
      return null;
    }
  }

  // ── 4. Stream watchdog ──────────────────────────────────────────────────

  /**
   * Wrap an upstream SSE stream with a first-token watchdog.
   *
   * If no content delta arrives within `streamWatchdogMs`, the watchdog:
   *   - Emits an error chunk so the client sees a clear failure (not empty 200)
   *   - Calls onTimeout so the executor can mark the session as expired
   *   - Closes the stream cleanly with [DONE]
   *
   * Also detects "stream ended with no content" — the exact bug from the
   * production logs where zai-web returned content: null, completion_tokens: 0.
   */
  withStreamWatchdog(
    stream: ReadableStream<Uint8Array>,
    options: {
      connectionId: string;
      onTimeout?: () => void;
      onEmptyStream?: () => void;
    }
  ): ReadableStream<Uint8Array> {
    let receivedContent = false;
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false; // Guard against double-close when watchdog + pipe race
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    // Capture the watchdog timeout so the ReadableStream closure can read it
    // without capturing `this` (which would prevent tree-shaking when no web
    // providers are configured).
    const watchdogMs = this.config.streamWatchdogMs;

    return new ReadableStream<Uint8Array>({
      start(controller) {
        const reader = stream.getReader();

        // Start the watchdog — if no content arrives in N seconds, abort
        watchdogTimer = setTimeout(() => {
          if (!receivedContent && !closed) {
            options.onTimeout?.();
            const errorChunk = JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: {
                    content: `[Web session error] No content received within ${watchdogMs}ms — session may be expired. Re-authenticate via the dashboard.`,
                  },
                  finish_reason: "stop",
                },
              ],
            });
            controller.enqueue(encoder.encode(`data: ${errorChunk}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            closed = true;
            controller.close();
            reader.cancel().catch(() => {});
          }
        }, watchdogMs);

        // Pipe the stream, tracking whether any content arrived
        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (watchdogTimer) clearTimeout(watchdogTimer);
                // If the stream ended with no content, that's a failure
                if (!receivedContent && !closed) {
                  options.onEmptyStream?.();
                  const errorChunk = JSON.stringify({
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content:
                            "[Web session error] Stream completed with no content — session is likely expired. Re-authenticate via the dashboard.",
                        },
                        finish_reason: "stop",
                      },
                    ],
                  });
                  controller.enqueue(encoder.encode(`data: ${errorChunk}\n\n`));
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                }
                if (!closed) {
                  closed = true;
                  controller.close();
                }
                return;
              }
              // Check if this chunk contains actual content (not just phase/done frames)
              const text = decoder.decode(value, { stream: true });
              if (
                text.includes('"content"') &&
                !text.includes('"content":""') &&
                !text.includes('"content":null')
              ) {
                receivedContent = true;
                if (watchdogTimer) {
                  clearTimeout(watchdogTimer);
                  watchdogTimer = null;
                }
              }
              if (!closed) {
                controller.enqueue(value);
              }
            }
          } catch (error) {
            if (watchdogTimer) clearTimeout(watchdogTimer);
            // If the stream errored with no content, report it
            if (!receivedContent && !closed) {
              options.onTimeout?.();
              const msg = sanitizeErrorMessage(
                error instanceof Error ? error.message : "stream error"
              );
              const errorChunk = JSON.stringify({
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: `[Web session error] Stream failed before any content: ${msg}`,
                    },
                    finish_reason: "stop",
                  },
                ],
              });
              controller.enqueue(encoder.encode(`data: ${errorChunk}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // already closed
              }
            }
          }
        })();
      },

      cancel() {
        if (watchdogTimer) clearTimeout(watchdogTimer);
      },
    });
  }

  // ── 5. Login-redirect detection ─────────────────────────────────────────

  /**
   * Check if the browser page landed on a login wall instead of the chat interface.
   * Called after browser navigation, before typing the prompt.
   *
   * Checks both URL patterns and common login-wall DOM indicators.
   */
  async detectLoginRedirect(page: import("playwright").Page): Promise<boolean> {
    try {
      const url = page.url();

      // Check URL patterns
      for (const pattern of this.config.loginRedirectPatterns) {
        if (pattern.test(url)) return true;
      }

      // Check for common login-wall DOM indicators
      const loginIndicators = await page
        .locator(
          'input[type="password"], [data-testid="login-form"], .login-container, #login-form, [aria-label="Sign in"]'
        )
        .count()
        .catch(() => 0);

      return loginIndicators > 0;
    } catch {
      // If we can't check the page, don't block the request
      return false;
    }
  }

  // ── 6. DOM health check ─────────────────────────────────────────────────

  /**
   * Verify that the chat page's critical selectors are present.
   * If they're missing, the provider's UI has changed and the executor will
   * fail silently on click/type operations.
   *
   * Returns the list of missing selectors so the executor can log a clear error.
   */
  async checkDomHealth(
    page: import("playwright").Page
  ): Promise<{ healthy: boolean; missingSelectors: string[] }> {
    const missing: string[] = [];
    for (const selector of this.config.domHealthSelectors) {
      try {
        const count = await page.locator(selector).count();
        if (count === 0) missing.push(selector);
      } catch {
        missing.push(selector);
      }
    }
    return { healthy: missing.length === 0, missingSelectors: missing };
  }

  // ── Health status accessors ─────────────────────────────────────────────

  /**
   * Get the cached health status for a connection.
   * Returns undefined if not cached or expired.
   */
  getHealth(connectionId: string): WebSessionHealth | undefined {
    return getCachedHealth(connectionId);
  }

  /**
   * Check if a connection is known to be expired.
   * Returns true only if the cache says expired (false = healthy or unknown).
   */
  isExpired(connectionId: string): boolean {
    const health = getCachedHealth(connectionId);
    return health?.status === "expired";
  }
}

// ── Session health summary (for monitoring API) ───────────────────────────

export function getAllSessionHealth(): Record<string, WebSessionHealth> {
  const result: Record<string, WebSessionHealth> = {};
  for (const [id, entry] of sessionHealthCache.entries()) {
    if (Date.now() <= entry.expiresAt) {
      result[id] = entry.health;
    } else {
      sessionHealthCache.delete(id);
    }
  }
  return result;
}

export function getSessionHealthSummary(): {
  total: number;
  healthy: number;
  expired: number;
  unknown: number;
} {
  const all = Object.values(getAllSessionHealth());
  return {
    total: all.length,
    healthy: all.filter((h) => h.status === "healthy").length,
    expired: all.filter((h) => h.status === "expired").length,
    unknown: all.filter((h) => h.status === "unknown").length,
  };
}
