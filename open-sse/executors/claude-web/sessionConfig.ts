/**
 * Claude web session configuration for the WebSessionDriver.
 *
 * LEV fork addition.
 */
import type { WebSessionConfig } from "../../services/webSessionDriver.ts";

export const CLAUDE_WEB_SESSION_CONFIG: WebSessionConfig = {
  providerId: "claude-web",
  // Lightweight endpoint that requires valid session cookies.
  // A 401/403 means the cookies are expired.
  sessionProbeUrl: "https://claude.ai/api/organizations",
  sessionProbeHeaders: (cookie) => ({
    Accept: "application/json",
    Cookie: cookie,
  }),
  refreshUrl: undefined, // Claude cookies require browser-based re-auth
  loginRedirectPatterns: [/claude\.ai\/(login|signin)/i, /anthropic\.com\/(login|signin)/i],
  domHealthSelectors: [
    'div[contenteditable="true"]',
    'fieldset[id*="input"]',
    'button[aria-label*="Send"]',
  ],
  streamWatchdogMs: 20_000, // Claude can be slower to start streaming
  emptyContentRetryMax: 1,
  cookieDomain: ".claude.ai",
};
