/**
 * ReAuthBrowserManager — Manages headless browser sessions for re-authentication.
 *
 * LEV fork addition.
 *
 * Launches a non-pooled browser (separate from the browserPool) with:
 *   - Headful mode (visible to screenshots, not headless)
 *   - No pre-seeded cookies (fresh session for login)
 *   - Screenshot capture at 2 FPS
 *   - 5-minute timeout
 *   - Cookie/token extraction on login success
 *
 * The manager is provider-aware: each provider has a re-auth config that
 * specifies the login URL, success URL pattern, and credential extraction
 * logic.
 */

import type { WebSessionConfig } from "./webSessionDriver.ts";

export interface ReAuthConfig {
  providerId: string;
  loginUrl: string;
  /** URL pattern that indicates login succeeded */
  successUrlPattern: RegExp;
  /** Extract credentials from the browser context after login */
  extractCredentials: (
    context: import("playwright").BrowserContext
  ) => Promise<{ token?: string; cookies?: string }>;
  /** Cookie domain for extraction */
  cookieDomain?: string;
  /** localStorage key for token-based providers */
  localStorageKey?: string;
  /** Origin for localStorage extraction */
  localStorageOrigin?: string;
}

export const RE_AUTH_CONFIGS: Record<string, ReAuthConfig> = {
  "zai-web": {
    providerId: "zai-web",
    loginUrl: "https://chat.z.ai/",
    successUrlPattern: /chat\.z\.ai\/(chat|\?model=)/i,
    localStorageKey: "token",
    localStorageOrigin: "https://chat.z.ai",
    extractCredentials: async (context) => {
      const pages = context.pages();
      const page = pages[0];
      if (!page) return {};
      const token = await page.evaluate(() => localStorage.getItem("token"));
      return { token: token || undefined };
    },
  },
  "gemini-web": {
    providerId: "gemini-web",
    loginUrl: "https://gemini.google.com/",
    successUrlPattern: /gemini\.google\.com\/app/i,
    cookieDomain: ".google.com",
    extractCredentials: async (context) => {
      const cookies = await context.cookies(".google.com");
      const cookieString = cookies
        .filter((c) => ["__Secure-1PSID", "__Secure-1PSIDTS", "__Secure-1PSIDCC"].includes(c.name))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      return { cookies: cookieString || undefined };
    },
  },
  "deepseek-web": {
    providerId: "deepseek-web",
    loginUrl: "https://chat.deepseek.com/",
    successUrlPattern: /chat\.deepseek\.com\/(a\/chat|chat)/i,
    cookieDomain: ".deepseek.com",
    extractCredentials: async (context) => {
      const cookies = await context.cookies(".deepseek.com");
      const userToken = cookies.find((c) => c.name === "userToken")?.value;
      const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      return { token: userToken, cookies: cookieString };
    },
  },
  huggingchat: {
    providerId: "huggingchat",
    loginUrl: "https://huggingface.co/chat/",
    successUrlPattern: /huggingface\.co\/chat/i,
    cookieDomain: ".huggingface.co",
    extractCredentials: async (context) => {
      const cookies = await context.cookies(".huggingface.co");
      const hfChat = cookies.find((c) => c.name === "hf-chat")?.value;
      return { cookies: hfChat ? `hf-chat=${hfChat}` : undefined };
    },
  },
  "claude-web": {
    providerId: "claude-web",
    loginUrl: "https://claude.ai/",
    successUrlPattern: /claude\.ai\/chat/i,
    cookieDomain: ".claude.ai",
    extractCredentials: async (context) => {
      const cookies = await context.cookies(".claude.ai");
      return { cookies: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
    },
  },
};

// ── Active re-auth sessions ────────────────────────────────────────────────

interface ActiveSession {
  sessionId: string;
  providerId: string;
  connectionId: string;
  startedAt: number;
  browser: import("playwright").Browser | null;
  context: import("playwright").BrowserContext | null;
  page: import("playwright").Page | null;
  config: ReAuthConfig;
  status: "active" | "success" | "failed" | "timeout";
  extractedCredentials?: { token?: string; cookies?: string };
  lastScreenshot?: string; // base64 PNG
  lastError?: string;
}

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONCURRENT_SESSIONS = 3;

const activeSessions = new Map<string, ActiveSession>();

// ── Session lifecycle ──────────────────────────────────────────────────────

/**
 * Start a re-authentication session for a provider.
 * Launches a headless browser pointing to the provider's login page.
 * Returns the session ID for subsequent screenshot/command calls.
 */
export async function startReAuthSession(
  providerId: string,
  connectionId: string
): Promise<{ sessionId: string; loginUrl: string } | { error: string }> {
  // Check concurrent session limit
  if (activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
    return { error: "Maximum concurrent re-auth sessions reached. Try again later." };
  }

  const config = RE_AUTH_CONFIGS[providerId];
  if (!config) {
    return { error: `Re-authentication not supported for provider: ${providerId}` };
  }

  // Clean up expired sessions
  cleanupExpiredSessions();

  try {
    // Launch a fresh browser (not from the pool — we want a clean session)
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const sessionId = `reauth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: ActiveSession = {
      sessionId,
      providerId,
      connectionId,
      startedAt: Date.now(),
      browser,
      context,
      page,
      config,
      status: "active",
    };
    activeSessions.set(sessionId, session);

    return { sessionId, loginUrl: config.loginUrl };
  } catch (error) {
    return {
      error: `Failed to launch browser: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Capture a screenshot of the current browser page.
 * Returns a base64-encoded PNG.
 */
export async function captureScreenshot(
  sessionId: string
): Promise<{ screenshot: string; url: string; status: string } | { error: string }> {
  const session = activeSessions.get(sessionId);
  if (!session) return { error: "Session not found" };
  if (!session.page) return { error: "Browser page not available" };

  // Check timeout
  if (Date.now() - session.startedAt > SESSION_TIMEOUT_MS) {
    session.status = "timeout";
    await cleanupSession(sessionId);
    return { error: "Session timed out" };
  }

  try {
    const screenshotBuffer = await session.page.screenshot({
      type: "png",
    });
    const screenshot = screenshotBuffer.toString("base64");
    const url = session.page.url();
    session.lastScreenshot = screenshot;

    // Check if login succeeded
    if (session.config.successUrlPattern.test(url)) {
      session.status = "success";
      // Extract credentials
      if (session.context) {
        session.extractedCredentials = await session.config
          .extractCredentials(session.context)
          .catch(() => ({}));
      }
    }

    return {
      screenshot,
      url,
      status: session.status,
    };
  } catch (error) {
    return {
      error: `Screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Execute a command in the browser (click, type, press, navigate).
 */
export async function executeReAuthCommand(
  sessionId: string,
  command: { type: string; selector?: string; text?: string; key?: string; url?: string }
): Promise<{ ok: boolean; error?: string }> {
  const session = activeSessions.get(sessionId);
  if (!session) return { ok: false, error: "Session not found" };
  if (!session.page) return { ok: false, error: "Browser page not available" };

  // Check timeout
  if (Date.now() - session.startedAt > SESSION_TIMEOUT_MS) {
    session.status = "timeout";
    await cleanupSession(sessionId);
    return { ok: false, error: "Session timed out" };
  }

  try {
    switch (command.type) {
      case "click":
        if (!command.selector) return { ok: false, error: "Missing selector" };
        await session.page.click(command.selector, { timeout: 10_000 });
        return { ok: true };

      case "type":
        if (!command.selector || command.text === undefined)
          return { ok: false, error: "Missing selector or text" };
        await session.page.fill(command.selector, command.text, { timeout: 10_000 });
        return { ok: true };

      case "press":
        if (!command.key) return { ok: false, error: "Missing key" };
        await session.page.keyboard.press(command.key);
        return { ok: true };

      case "navigate":
        if (!command.url) return { ok: false, error: "Missing URL" };
        await session.page.goto(command.url, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        return { ok: true };

      case "done":
        // User indicates login is complete — try to extract credentials
        if (session.context) {
          session.extractedCredentials = await session.config
            .extractCredentials(session.context)
            .catch(() => ({}));
          if (session.extractedCredentials?.token || session.extractedCredentials?.cookies) {
            session.status = "success";
          } else {
            session.status = "failed";
            session.lastError = "No credentials found after login";
          }
        }
        return { ok: true };

      default:
        return { ok: false, error: `Unknown command type: ${command.type}` };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get the extracted credentials after a successful re-auth.
 * The caller is responsible for persisting them to the provider connection.
 */
export function getExtractedCredentials(
  sessionId: string
): { token?: string; cookies?: string } | { error: string } {
  const session = activeSessions.get(sessionId);
  if (!session) return { error: "Session not found" };
  if (session.status !== "success") return { error: `Session status: ${session.status}` };
  return session.extractedCredentials ?? { error: "No credentials extracted" };
}

/**
 * Clean up a re-auth session — close the browser and remove from active set.
 */
export async function cleanupSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  try {
    await session.browser?.close().catch(() => {});
  } finally {
    activeSessions.delete(sessionId);
  }
}

/**
 * Clean up expired sessions (called on each new session start).
 */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of activeSessions.entries()) {
    if (now - session.startedAt > SESSION_TIMEOUT_MS) {
      session.browser?.close().catch(() => {});
      activeSessions.delete(id);
    }
  }
}

/**
 * Get the status of a re-auth session.
 */
export function getSessionStatus(
  sessionId: string
): { status: string; providerId: string; url?: string; error?: string } | { error: string } {
  const session = activeSessions.get(sessionId);
  if (!session) return { error: "Session not found" };
  return {
    status: session.status,
    providerId: session.providerId,
    url: session.page?.url(),
    error: session.lastError,
  };
}

/**
 * Get the WebSessionConfig for a provider (used to map re-auth credentials
 * to the right field name for persistence).
 */
export function getProviderSessionConfig(providerId: string): WebSessionConfig | undefined {
  // Re-export the session configs from the executor directories
  // This is a convenience accessor for the API route
  switch (providerId) {
    case "zai-web":
      return undefined; // The API route imports the config directly
    default:
      return undefined;
  }
}
