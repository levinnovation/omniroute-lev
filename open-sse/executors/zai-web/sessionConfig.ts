/**
 * Z.ai web session configuration for the WebSessionDriver.
 *
 * LEV fork addition.
 */
import type { WebSessionConfig } from "../../services/webSessionDriver.ts";

export const ZAI_WEB_SESSION_CONFIG: WebSessionConfig = {
  providerId: "zai-web",
  // Lightweight endpoint that requires a valid Bearer token — returns user settings JSON.
  // 401/403 means the JWT is expired.
  sessionProbeUrl: "https://chat.z.ai/api/v1/users/user/settings",
  sessionProbeHeaders: (token) => ({
    Accept: "application/json, text/plain, */*",
    Authorization: `Bearer ${token}`,
    Origin: "https://chat.z.ai",
    Referer: "https://chat.z.ai/",
  }),
  // Z.ai does not expose a server-side token refresh endpoint — the JWT is
  // issued at login and expires. Re-authentication requires browser interaction.
  refreshUrl: undefined,
  loginRedirectPatterns: [
    /chat\.z\.ai\/(login|auth|signin)/i,
    // If we land on the root with no chat context, it might be a login wall
    // (the chat page normally has ?model=... or /chat/...)
    /^https?:\/\/chat\.z\.ai\/?$/i,
  ],
  domHealthSelectors: [
    "#chat-input",
    'textarea[id="chat-input"]',
    '[aria-label="Send Message"] button',
    'button[aria-label="Send Message"]',
  ],
  streamWatchdogMs: 15_000, // 15 seconds for first token
  emptyContentRetryMax: 1,
  localStorageKey: "token",
  localStorageOrigin: "https://chat.z.ai",
};
