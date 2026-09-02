// LEV fork: SSE proactive-close + Last-Event-ID resume support.
//
// Tracks the last event ID for each streaming response and provides helpers
// for proactive stream closure (so a long-lived SSE connection can be closed
// before upstream proxies idle-timeout it, letting the client reconnect with
// Last-Event-ID to resume). This is a utility module — not wired into the hot
// path yet; it is available for gradual adoption by the streaming handlers.
//
// Exports:
//   - SseResumeTracker: per-stream last-event-ID tracker
//   - getResumeHeaders(lastEventId): headers for a reconnect request
//   - shouldCloseStream(elapsedMs): proactive-close decision (4 min default)

export const PROACTIVE_CLOSE_MS = 240_000;

export interface ResumeHeaders {
  "Last-Event-ID": string;
}

/**
 * Build the headers to send on a reconnect request so the upstream can
 * resume from the last event the client received. Returns an empty object
 * when no last-event-ID is available.
 */
export function getResumeHeaders(lastEventId: string | null | undefined): Record<string, string> {
  if (!lastEventId) return {};
  return { "Last-Event-ID": lastEventId };
}

/**
 * Decide whether a stream should be proactively closed to let the client
 * reconnect with Last-Event-ID. Defaults to 4 minutes (240000ms) — short
 * enough to stay under common reverse-proxy idle timeouts (nginx 5min,
 * Cloudflare 100s) while still amortizing connection setup.
 */
export function shouldCloseStream(
  elapsedMs: number,
  thresholdMs: number = PROACTIVE_CLOSE_MS
): boolean {
  return elapsedMs >= thresholdMs;
}

/**
 * Per-stream tracker for the last received event ID. Call `update(id)` on
 * every event that carries an `id` field; call `getLastEventId()` when
 * building resume headers for a reconnect.
 */
export class SseResumeTracker {
  private lastEventId: string | null = null;
  private readonly startedAt: number;

  constructor() {
    this.startedAt = Date.now();
  }

  update(id: string | undefined | null): void {
    if (typeof id === "string" && id.length > 0) {
      this.lastEventId = id;
    }
  }

  getLastEventId(): string | null {
    return this.lastEventId;
  }

  getResumeHeaders(): Record<string, string> {
    return getResumeHeaders(this.lastEventId);
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  shouldClose(thresholdMs: number = PROACTIVE_CLOSE_MS): boolean {
    return shouldCloseStream(this.elapsedMs(), thresholdMs);
  }
}
