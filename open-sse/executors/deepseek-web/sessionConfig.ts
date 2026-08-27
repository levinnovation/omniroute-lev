/**
 * DeepSeek web session configuration for the WebSessionDriver.
 *
 * LEV fork addition.
 */
import type { WebSessionConfig } from "../../services/webSessionDriver.ts";

export const DEEPSEEK_WEB_SESSION_CONFIG: WebSessionConfig = {
  providerId: "deepseek-web",
  // Lightweight endpoint that requires a valid Bearer access token.
  // A 401 means the token is expired and needs refresh.
  sessionProbeUrl: "https://chat.deepseek.com/api/v0/users/current",
  sessionProbeHeaders: (token) => ({
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  }),
  // DeepSeek supports token refresh via the userToken → accessToken flow
  // (already implemented in deepseek-web.ts::acquireAccessToken).
  // The driver's refreshSession is a fallback; the executor's auto-refresh
  // subclass handles the primary refresh path.
  refreshUrl: undefined,
  loginRedirectPatterns: [
    /chat\.deepseek\.com\/(login|signin)/i,
    /platform\.deepseek\.com\/(login|signin)/i,
  ],
  domHealthSelectors: [
    'textarea[class*="chat-input"]',
    "#chat-input",
    'div[contenteditable="true"]',
  ],
  streamWatchdogMs: 15_000,
  emptyContentRetryMax: 1,
};
