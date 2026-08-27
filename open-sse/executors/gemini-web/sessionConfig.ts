/**
 * Gemini web session configuration for the WebSessionDriver.
 *
 * LEV fork addition.
 */
import type { WebSessionConfig } from "../../services/webSessionDriver.ts";

export const GEMINI_WEB_SESSION_CONFIG: WebSessionConfig = {
  providerId: "gemini-web",
  // Lightweight endpoint that requires valid __Secure-1PSID cookies.
  // A 401/403 means the cookies are expired.
  sessionProbeUrl:
    "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
  sessionProbeHeaders: (cookie) => ({
    Accept: "text/html,application/xhtml+xml",
    Cookie: cookie,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  }),
  refreshUrl: undefined, // Google cookies are rotated by the browser, not server-side
  loginRedirectPatterns: [/accounts\.google\.com/i, /gemini\.google\.com\/(login|signin)/i],
  domHealthSelectors: [
    'div[contenteditable="true"]',
    "rich-textarea",
    'button[aria-label="Send message"]',
  ],
  streamWatchdogMs: 15_000,
  emptyContentRetryMax: 1,
  cookieDomain: ".google.com",
};
