/**
 * HuggingChat session configuration for the WebSessionDriver.
 *
 * LEV fork addition.
 */
import type { WebSessionConfig } from "../../services/webSessionDriver.ts";

export const HUGGINGCHAT_SESSION_CONFIG: WebSessionConfig = {
  providerId: "huggingchat",
  // Lightweight endpoint that requires a valid hf-chat session cookie.
  // A 401/403 means the cookie is expired.
  sessionProbeUrl: "https://huggingface.co/chat/api/v2/conversations?limit=0",
  sessionProbeHeaders: (cookie) => ({
    Accept: "application/json",
    Cookie: cookie,
  }),
  refreshUrl: undefined,
  loginRedirectPatterns: [/huggingface\.co\/(login|signin)/i, /huggingface\.co\/auth/i],
  domHealthSelectors: ['textarea[class*="chat"]', "#chat-input", 'div[contenteditable="true"]'],
  streamWatchdogMs: 15_000,
  emptyContentRetryMax: 1,
  cookieDomain: ".huggingface.co",
};
