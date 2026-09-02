/**
 * cookieRefresh.ts — Proactive cookie refresh for web-cookie providers.
 *
 * LEV fork addition (Phase 6). Estimates cookie lifetime from expiry dates,
 * triggers a refresh when cookies reach 75% of their lifetime, and schedules
 * periodic background checks for all active web-cookie connections.
 */
import { acquireBrowserContext, openPage, releaseBrowserContext } from "./browserPool.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";

type Page = import("playwright").Page;

export interface CookieRecord {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

export interface WebCookieConnection {
  providerId: string;
  connectionId: string;
  cookies: CookieRecord[] | string;
  loginUrl?: string;
  cookieDomain?: string;
  localStorage?: Record<string, string>;
  localStorageOrigin?: string;
  lastRefreshedAt?: number;
}

export interface CookieLifetimeEstimate {
  earliestExpiryMs: number;
  latestExpiryMs: number;
  hasExpiry: boolean;
  lifetimeMs: number;
}

const REFRESH_THRESHOLD = 0.75;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let checkTimer: NodeJS.Timeout | null = null;

export function parseCookieString(cookieHeader: string): CookieRecord[] {
  return cookieHeader
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return null;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) return null;
      return { name, value, expires: -1 } as CookieRecord;
    })
    .filter((c): c is CookieRecord => c !== null);
}

export function getCookieLifetime(
  _provider: string,
  cookies: CookieRecord[] | string
): CookieLifetimeEstimate {
  const records = typeof cookies === "string" ? parseCookieString(cookies) : cookies;
  const now = Date.now();
  const expiries = records
    .map((c) => (typeof c.expires === "number" && c.expires > 0 ? c.expires * 1000 : null))
    .filter((e): e is number => e !== null && e > now);

  if (expiries.length === 0) {
    return { earliestExpiryMs: 0, latestExpiryMs: 0, hasExpiry: false, lifetimeMs: 0 };
  }

  const earliest = Math.min(...expiries);
  const latest = Math.max(...expiries);
  return {
    earliestExpiryMs: earliest,
    latestExpiryMs: latest,
    hasExpiry: true,
    lifetimeMs: Math.max(latest - now, 0),
  };
}

export function shouldRefreshCookies(provider: string, connection: WebCookieConnection): boolean {
  const lifetime = getCookieLifetime(provider, connection.cookies);
  if (!lifetime.hasExpiry) return false;
  const now = Date.now();
  const elapsed = now - (connection.lastRefreshedAt ?? 0);
  if (elapsed < MIN_REFRESH_INTERVAL_MS) return false;
  const remaining = lifetime.earliestExpiryMs - now;
  const total =
    lifetime.earliestExpiryMs - (connection.lastRefreshedAt ?? now - lifetime.lifetimeMs);
  if (total <= 0) return remaining <= 0;
  const consumedRatio = 1 - remaining / total;
  return consumedRatio >= REFRESH_THRESHOLD;
}

export interface RefreshResult {
  refreshed: boolean;
  cookies: CookieRecord[] | null;
  error?: string;
}

export async function refreshCookies(
  provider: string,
  connection: WebCookieConnection
): Promise<RefreshResult> {
  const loginUrl = connection.loginUrl ?? guessLoginUrl(provider);
  if (!loginUrl) {
    return { refreshed: false, cookies: null, error: `No login URL configured for ${provider}` };
  }

  const cookieDomain = connection.cookieDomain ?? guessCookieDomain(provider);
  if (!cookieDomain) {
    return { refreshed: false, cookies: null, error: `No cookie domain for ${provider}` };
  }

  const poolKey = `refresh:${provider}:${connection.connectionId}`;
  let page: Page | null = null;
  try {
    const pooled = await acquireBrowserContext(poolKey, {
      cookieDomain,
      localStorage: connection.localStorage,
      localStorageOrigin: connection.localStorageOrigin,
      warmupUrl: loginUrl,
    });
    page = await openPage(pooled);
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    await waitForAuthentication(page, 60_000);

    const context = pooled.context;
    const freshCookies = await context.cookies();
    const records: CookieRecord[] = freshCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite as "Lax" | "Strict" | "None",
    }));

    await releaseBrowserContext(poolKey);
    return { refreshed: true, cookies: records };
  } catch (error) {
    const message = sanitizeErrorMessage(error instanceof Error ? error.message : "refresh failed");
    return { refreshed: false, cookies: null, error: message };
  } finally {
    try {
      if (page) await page.close();
    } catch {
      // ignore
    }
  }
}

async function waitForAuthentication(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (!/\/(login|auth|signin|sign-in)/i.test(url)) {
      const loginForm = await page
        .locator('input[type="password"], [data-testid="login-form"]')
        .count()
        .catch(() => 0);
      if (loginForm === 0) return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function guessLoginUrl(provider: string): string | null {
  const map: Record<string, string> = {
    "zai-web": "https://chat.z.ai",
    "deepseek-web": "https://chat.deepseek.com",
    "gemini-web": "https://gemini.google.com",
    "perplexity-web": "https://www.perplexity.ai",
    "qwen-web": "https://chat.qwen.ai",
    huggingchat: "https://huggingface.co/chat",
    "t3-chat-web": "https://t3.chat",
  };
  return map[provider] ?? null;
}

function guessCookieDomain(provider: string): string | null {
  const map: Record<string, string> = {
    "zai-web": "chat.z.ai",
    "deepseek-web": "chat.deepseek.com",
    "gemini-web": "gemini.google.com",
    "perplexity-web": "www.perplexity.ai",
    "qwen-web": "chat.qwen.ai",
    huggingchat: "huggingface.co",
    "t3-chat-web": "t3.chat",
  };
  return map[provider] ?? null;
}

export type ConnectionFetcher = () => Promise<WebCookieConnection[]>;
export type ConnectionUpdater = (connectionId: string, cookies: CookieRecord[]) => Promise<void>;

export interface RefreshSchedulerOptions {
  fetchConnections?: ConnectionFetcher;
  updateConnection?: ConnectionUpdater;
  intervalMs?: number;
}

export async function runRefreshCycle(options: RefreshSchedulerOptions): Promise<void> {
  const fetcher = options.fetchConnections ?? (() => Promise.resolve([]));
  const updater = options.updateConnection ?? (() => Promise.resolve());
  const connections = await fetcher();
  for (const connection of connections) {
    if (!shouldRefreshCookies(connection.providerId, connection)) continue;
    const result = await refreshCookies(connection.providerId, connection);
    if (result.refreshed && result.cookies) {
      await updater(connection.connectionId, result.cookies);
    }
  }
}

export function startCookieRefreshScheduler(options: RefreshSchedulerOptions): void {
  if (checkTimer) return;
  const interval = options.intervalMs ?? CHECK_INTERVAL_MS;
  checkTimer = setInterval(() => {
    void runRefreshCycle(options).catch(() => {});
  }, interval);
  checkTimer.unref?.();
}

export function stopCookieRefreshScheduler(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
