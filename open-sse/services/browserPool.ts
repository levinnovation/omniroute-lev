/**
 * browserPool.ts — Shared stealth browser pool for web-cookie providers.
 *
 * The DuckDuckGo VQD challenge and Claude web's Cloudflare Turnstile both
 * validate values that only a real browser can produce (DOM layout
 * measurements like offsetWidth/Height, getBoundingClientRect,
 * getComputedStyle, iframe contentWindow probes). Plain Node fetch + a
 * VM-stubs solver structurally runs the JS but cannot match those values,
 * so the server rejects the request.
 *
 * This pool keeps one Chromium instance warm and serves "browser contexts"
 * (one per caller-defined isolation key) on demand. Each context owns one or more pages; the
 * caller is expected to be polite (one page per request, close on done).
 *
 * The pool prefers `cloakbrowser` (npm) when available — its binary-level
 * fingerprint patches (--fingerprint-timezone, --fingerprint-locale, and
 * dozens more) are the only thing that gets past DuckDuckGo's anti-bot
 * in this environment. Falls back to plain `playwright` if cloakbrowser
 * is not installed; the fallback works for Claude web (which only needs
 * valid cookies) but not for DDG's VQD challenge.
 *
 * Opt-in: pool only launches Chromium when an executor explicitly asks
 * for a context, so users who never use the browser-backed path pay zero
 * startup cost. Set OMNIROUTE_BROWSER_POOL=off to fully disable.
 */

import { Buffer } from "node:buffer";

type Browser = import("playwright").Browser;
type BrowserContext = import("playwright").BrowserContext;
type Page = import("playwright").Page;

export interface BrowserPoolContextOptions {
  cookieDomain: string;
  cookieString?: string | null;
  localStorage?: Record<string, string>;
  localStorageOrigin?: string;
  warmupUrl?: string | null;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  preferCloakbrowser?: boolean;
  proxyProviderKey?: string;
}

export interface PooledContext {
  id: string;
  context: BrowserContext;
  warmupPage: Page | null;
  lastUsed: number;
  isStealth: boolean;
}

// #3368 PR7 — lightweight, cumulative browser-pool telemetry. Counters are
// incremented at lifecycle points and surfaced via getBrowserPoolMetrics()
// (and the omniroute_browser_pool_status MCP tool), giving the previously
// caller-less getBrowserPoolStatus() an observability home.
export interface BrowserPoolMetrics {
  browserLaunches: number;
  browserLaunchFailures: number;
  contextsCreated: number;
  contextsReused: number;
  contextsEvicted: number;
  contextsReleased: number;
  contextCreateFailures: number;
  shutdowns: number;
  lastShutdownReason: string | null;
}

function createBrowserPoolMetrics(): BrowserPoolMetrics {
  return {
    browserLaunches: 0,
    browserLaunchFailures: 0,
    contextsCreated: 0,
    contextsReused: 0,
    contextsEvicted: 0,
    contextsReleased: 0,
    contextCreateFailures: 0,
    shutdowns: 0,
    lastShutdownReason: null,
  };
}

interface PoolState {
  browser: Browser | null;
  contexts: Map<string, PooledContext>;
  pendingContexts: Map<string, Promise<PooledContext>>;
  launching: Promise<Browser> | null;
  lastActivity: number;
  idleTimer: NodeJS.Timeout | null;
  evictTimer: NodeJS.Timeout | null;
  cloakLaunch: ((opts: unknown) => Promise<Browser>) | null;
  cloakLaunchResolved: boolean;
  metrics: BrowserPoolMetrics;
}

const POOL_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CONTEXT_TTL_MS = 10 * 60 * 1000; // 10 min — evict stale contexts
const EVICT_INTERVAL_MS = 60 * 1000; // check every 60s
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// LEV fork: Reconnection and retry constants.
// The browser pool caches the Browserless CDP connection, but Browserless
// times out sessions (120-300s). When the WebSocket disconnects, the cached
// browser becomes a dead reference. These constants control the auto-reconnect
// and retry behavior that prevents "Target page, context or browser has been
// closed" errors.
const MAX_CONTEXT_RETRIES = 2;
const CONTEXT_RETRY_DELAY_MS = 500;

const state: PoolState = {
  browser: null,
  contexts: new Map(),
  pendingContexts: new Map(),
  launching: null,
  lastActivity: 0,
  idleTimer: null,
  evictTimer: null,
  cloakLaunch: null,
  cloakLaunchResolved: false,
  metrics: createBrowserPoolMetrics(),
};

// LEV fork: Clear all stale state when the browser disconnects. The browser
// reference is dead, so all contexts (which are children of the browser) are
// also dead. Pending context creations will reject on their own.
function clearStaleBrowserState(): void {
  console.log("[BrowserPool] Clearing stale browser state — browser disconnected or closed");
  state.browser = null;
  state.contexts.clear();
  state.pendingContexts.clear();
  state.launching = null;
}

// LEV fork: Check if the cached browser is still connected. Playwright's
// Browser.isConnected() returns false after the CDP WebSocket disconnects
// (Browserless timeout, network issue, or explicit close).
function isBrowserAlive(): boolean {
  if (!state.browser) return false;
  try {
    return state.browser.isConnected();
  } catch {
    // isConnected() can throw if the browser object is in a bad state
    return false;
  }
}

// LEV fork: Classify context-creation errors to decide retry strategy.
// "Target closed" → browser died, force reconnect.
// "429"/"queue"/"concurrent" → Browserless capacity, retry with backoff.
function classifyContextError(err: unknown): "target-closed" | "queue-full" | "other" {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("Target") && msg.includes("closed")) return "target-closed";
  if (
    msg.includes("429") ||
    msg.includes("queue") ||
    msg.includes("concurrent") ||
    msg.includes("capacity")
  ) {
    return "queue-full";
  }
  return "other";
}

// LEV fork: Replace cloakbrowser (obfuscated dynamic import, off-lockfile) with
// patchright — a drop-in Playwright replacement with built-in stealth patches.
// Same API as playwright, no version drift risk, properly pinned in package.json.
async function resolveStealthLaunch(): Promise<((opts: unknown) => Promise<Browser>) | null> {
  if (state.cloakLaunchResolved) return state.cloakLaunch;
  state.cloakLaunchResolved = true;
  try {
    const { chromium } = await import("patchright");
    state.cloakLaunch = ((opts: unknown) =>
      chromium.launch(opts as Parameters<typeof chromium.launch>[0])) as (
      opts: unknown
    ) => Promise<Browser>;
  } catch {
    state.cloakLaunch = null;
  }
  return state.cloakLaunch;
}

// LEV fork: Browserless sidecar CDP connection. When the Browserless sidecar is
// configured (OMNIROUTE_BROWSERLESS_URL + OMNIROUTE_BROWSERLESS_TOKEN), connect
// to its WebSocket endpoint via chromium.connectOverCDP() instead of launching
// a local browser. Falls back to local launch on any failure.
async function connectBrowserless(): Promise<Browser | null> {
  const { getBrowserlessWsUrl } = await import("./sidecars.ts");
  const wsUrl = getBrowserlessWsUrl();
  if (!wsUrl) return null;
  try {
    const stealthLaunch = await resolveStealthLaunch();
    const chromium =
      stealthLaunch !== null
        ? (await import("patchright")).chromium
        : (await import("playwright")).chromium;
    console.log(
      "[BrowserPool] Connecting to Browserless sidecar via CDP:",
      wsUrl.replace(/\?token=.*/, "?token=***")
    );
    const browser = await chromium.connectOverCDP(wsUrl);
    console.log("[BrowserPool] Connected to Browserless sidecar via CDP");
    return browser as Browser;
  } catch (err) {
    console.warn(
      "[BrowserPool] Browserless CDP connection failed, falling back to local launch:",
      err
    );
    return null;
  }
}

function isPoolEnabled(): boolean {
  const flag = process.env.OMNIROUTE_BROWSER_POOL;
  if (flag === undefined) return true;
  return flag !== "off" && flag !== "0" && flag !== "false";
}

function resetIdleTimer(): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    void shutdownPool("idle-timeout");
  }, POOL_IDLE_TIMEOUT_MS);
  state.idleTimer.unref?.();
}

function evictStaleContexts(): void {
  const now = Date.now();
  for (const [key, pooled] of state.contexts) {
    if (now - pooled.lastUsed > CONTEXT_TTL_MS) {
      console.log(
        "[BrowserPool] Evicted stale context",
        "(idle",
        ((now - pooled.lastUsed) / 1000).toFixed(0) + "s)"
      );
      state.contexts.delete(key);
      state.metrics.contextsEvicted++;
      pooled.context.close().catch(() => {});
    }
  }
  if (state.contexts.size === 0 && !state.launching) {
    void shutdownPool("all-contexts-evicted");
  }
}

function startEvictTimer(): void {
  if (state.evictTimer) clearInterval(state.evictTimer);
  state.evictTimer = setInterval(() => evictStaleContexts(), EVICT_INTERVAL_MS);
  state.evictTimer.unref?.();
}

interface ProxyRecord {
  type?: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
}

interface ResolvePlaywrightProxyDeps {
  resolveProxy?: (providerId: string) => Promise<ProxyRecord | null | undefined>;
}

// Exported for tests (deps injection avoids mock.module()).
export async function resolvePlaywrightProxy(
  providerKey: string,
  deps?: ResolvePlaywrightProxyDeps
): Promise<import("playwright").LaunchOptions["proxy"] | undefined> {
  try {
    const resolver =
      deps?.resolveProxy ??
      (async (id: string) => {
        const { resolveProxyForProvider } = await import("../../src/lib/db/proxies");
        return resolveProxyForProvider(id);
      });
    const p = await resolver(providerKey);
    if (!p?.host) return undefined;
    const scheme = p.type === "socks5" ? "socks5" : "http";
    // Build explicitly instead of a conditional object spread: the spread form
    // widens username/password to `{}` under the LaunchOptions["proxy"] type,
    // tripping typecheck once browserPool.ts is pulled into typecheck-core scope.
    const proxy: NonNullable<import("playwright").LaunchOptions["proxy"]> = {
      server: `${scheme}://${p.host}:${p.port}`,
    };
    if (p.username) {
      proxy.username = String(p.username);
      proxy.password = p.password == null ? "" : String(p.password);
    }
    return proxy;
  } catch (err) {
    console.warn("[BrowserPool] Failed to resolve proxy from DB:", err);
    return undefined;
  }
}

export async function resolveBrowserContextProxy(
  contextKey: string,
  options: Pick<BrowserPoolContextOptions, "proxyProviderKey">,
  deps?: ResolvePlaywrightProxyDeps
): Promise<import("playwright").LaunchOptions["proxy"] | undefined> {
  return resolvePlaywrightProxy(options.proxyProviderKey ?? contextKey, deps);
}

async function launchBrowser(): Promise<Browser> {
  // LEV fork: Check if the cached browser is still connected before reusing
  // it. Browserless times out sessions (120-300s), and the CDP WebSocket
  // disconnects silently. Without this check, the pool returns a dead browser
  // reference, causing "Target page, context or browser has been closed" on
  // the next newContext() call.
  if (state.browser) {
    if (isBrowserAlive()) return state.browser;
    console.log("[BrowserPool] Cached browser is disconnected — reconnecting");
    clearStaleBrowserState();
  }
  if (state.launching) return state.launching;
  state.launching = (async () => {
    // LEV fork: Try Browserless sidecar via CDP first, fall back to local launch.
    let browser: Browser | null = await connectBrowserless();
    if (!browser) {
      const stealthLaunch = await resolveStealthLaunch();
      if (stealthLaunch) {
        browser = await stealthLaunch({
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        });
      } else {
        // Fallback: plain Playwright. Works for Claude web (cookie-only
        // auth) but DDG's VQD challenge will detect this Chromium build.
        const { chromium } = await import("playwright");
        browser = await chromium.launch({
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
          ],
        });
      }
    }
    // LEV fork: Wire the disconnected event so we auto-clear the stale
    // reference. This fires when Browserless times out the session, when the
    // network drops, or when the browser crashes. Without this, the pool
    // would keep returning the dead browser until the next isConnected()
    // check at the top of this function.
    browser.on("disconnected", () => {
      console.log("[BrowserPool] Browser disconnected event — clearing pool for reconnect");
      clearStaleBrowserState();
    });
    state.browser = browser;
    state.launching = null;
    state.metrics.browserLaunches++;
    return browser;
  })();
  try {
    return await state.launching;
  } catch (err) {
    state.launching = null;
    state.metrics.browserLaunchFailures++;
    throw err;
  }
}

function parseCookieString(
  raw: string,
  domain: string
): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
}> {
  return raw
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return null;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name || !value) return null;
      return {
        name,
        value,
        domain: domain.startsWith(".") ? domain : `.${domain}`,
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: "Lax" as const,
      };
    })
    .filter(Boolean) as Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Lax" | "Strict" | "None";
  }>;
}

// Clear a key from the pending-creation map once its promise settles, counting
// failures. Kept as a leaf helper so acquireBrowserContext stays under the
// function-length ceiling (#3368 PR7 metrics).
function settlePendingContext(key: string, failed: boolean): void {
  if (failed) state.metrics.contextCreateFailures++;
  state.pendingContexts.delete(key);
}

// Seed a freshly created context with whatever session material the caller
// supplied — cookies for cookie-auth providers, localStorage for the ones (zai-web)
// whose session is a Bearer JWT the page reads at boot. Kept as a leaf helper so
// the creation closure stays under the complexity ceiling.
async function seedContextSession(
  context: BrowserContext,
  options: BrowserPoolContextOptions
): Promise<void> {
  if (options.cookieString) {
    const cookies = parseCookieString(options.cookieString, options.cookieDomain);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }
  }

  if (!options.localStorage || Object.keys(options.localStorage).length === 0) return;

  const origin = new URL(options.localStorageOrigin || options.warmupUrl || "").origin;
  await context.addInitScript(
    ({ expectedOrigin, entries }) => {
      if (window.location.origin !== expectedOrigin) return;
      for (const [name, value] of entries) {
        window.localStorage.setItem(name, value);
      }
    },
    {
      expectedOrigin: origin,
      entries: Object.entries(options.localStorage),
    }
  );
}

export async function acquireBrowserContext(
  key: string,
  options: BrowserPoolContextOptions
): Promise<PooledContext> {
  if (!isPoolEnabled()) {
    throw new Error(
      "browserPool: OMNIROUTE_BROWSER_POOL=off — context requested but pool is disabled"
    );
  }
  // LEV fork: If the cached browser is dead (Browserless timeout, network
  // drop), clear all stale state before attempting to reuse contexts. This
  // prevents returning a dead context that would fail on the first page
  // operation.
  if (state.browser && !isBrowserAlive()) {
    console.log("[BrowserPool] Stale browser detected in acquireBrowserContext — clearing");
    clearStaleBrowserState();
  }
  const existing = state.contexts.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    state.lastActivity = Date.now();
    state.metrics.contextsReused++;
    resetIdleTimer();
    return existing;
  }

  // Dedup concurrent creations for the same key
  const pending = state.pendingContexts.get(key);
  if (pending) return pending;

  const createPromise = (async (): Promise<PooledContext> => {
    const proxy = await resolveBrowserContextProxy(key, options);

    // LEV fork: Retry context creation with backoff. The browser can die
    // between launchBrowser() and newContext() (race with Browserless
    // timeout), or Browserless can reject due to capacity limits.
    let browser: Browser;
    let context: BrowserContext;
    for (let attempt = 0; attempt <= MAX_CONTEXT_RETRIES; attempt++) {
      browser = await launchBrowser();
      try {
        context = await browser.newContext({
          userAgent: options.userAgent || DEFAULT_USER_AGENT,
          locale: options.locale || "en-US",
          timezoneId: options.timezone || "America/New_York",
          viewport: { width: 1280, height: 800 },
          ...(proxy ? { proxy } : {}),
        });
        break; // Success
      } catch (err) {
        const errorKind = classifyContextError(err);
        if (errorKind === "target-closed") {
          // Browser died between launch and newContext — force reconnect
          console.log(
            `[BrowserPool] Context creation failed (attempt ${attempt + 1}/${MAX_CONTEXT_RETRIES + 1}): browser closed — reconnecting`
          );
          clearStaleBrowserState();
          if (attempt < MAX_CONTEXT_RETRIES) continue;
          throw err;
        }
        if (errorKind === "queue-full" && attempt < MAX_CONTEXT_RETRIES) {
          // Browserless capacity — retry with backoff
          const delay = CONTEXT_RETRY_DELAY_MS * (attempt + 1);
          console.log(
            `[BrowserPool] Context creation queued (attempt ${attempt + 1}/${MAX_CONTEXT_RETRIES + 1}): retrying in ${delay}ms`
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    const isStealth = state.cloakLaunch !== null;

    await seedContextSession(context!, options);

    let warmupPage: Page | null = null;
    if (options.warmupUrl) {
      try {
        warmupPage = await context!.newPage();
        await warmupPage.goto(options.warmupUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        // Give the warmup a moment for the upstream's status/auth/country
        // JSON endpoints to fire. Without this, the first chat request would
        // pay the warmup cost on the hot path.
        await new Promise((r) => setTimeout(r, 1500));
      } catch (err) {
        try {
          await warmupPage?.close();
        } catch {
          /* ignore */
        }
        warmupPage = null;
        void err;
      }
    }

    // Guard: if shutdownPool() ran while we were creating this context,
    // the browser we obtained is now closed. Close our temp context and
    // throw so the caller knows to retry.
    if (state.browser !== browser!) {
      await context!.close().catch(() => {});
      if (warmupPage) {
        await warmupPage.close().catch(() => {});
      }
      throw new Error("Pool shut down during context creation");
    }

    const pooled: PooledContext = {
      id: key,
      context: context!,
      warmupPage,
      lastUsed: Date.now(),
      isStealth,
    };
    state.contexts.set(key, pooled);
    state.metrics.contextsCreated++;
    state.lastActivity = Date.now();
    resetIdleTimer();
    startEvictTimer();
    return pooled;
  })();

  state.pendingContexts.set(key, createPromise);
  createPromise
    .then(() => settlePendingContext(key, false))
    .catch(() => settlePendingContext(key, true));

  return createPromise;
}

export async function openPage(pooled: PooledContext): Promise<Page> {
  return pooled.context.newPage();
}

export async function releaseBrowserContext(key: string): Promise<void> {
  const pooled = state.contexts.get(key);
  if (!pooled) return;
  state.contexts.delete(key);
  state.metrics.contextsReleased++;
  try {
    await pooled.context.close();
  } catch {
    /* ignore */
  }
  if (state.contexts.size === 0) {
    await shutdownPool("last-context-closed");
  }
}

export async function shutdownPool(reason: string): Promise<void> {
  state.metrics.shutdowns++;
  state.metrics.lastShutdownReason = reason;
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  if (state.evictTimer) {
    clearInterval(state.evictTimer);
    state.evictTimer = null;
  }
  state.pendingContexts.clear();
  for (const [key, pooled] of state.contexts) {
    try {
      await pooled.context.close();
    } catch {
      /* ignore */
    }
    state.contexts.delete(key);
  }
  if (state.browser) {
    try {
      await state.browser.close();
    } catch {
      /* ignore */
    }
    state.browser = null;
  }
  state.lastActivity = Date.now();
  // Avoid unused-parameter lint: log reason via debug if anyone hooks
  // process.on('exit') and prints state.
  void reason;
}

export function getBrowserPoolStatus(): {
  enabled: boolean;
  contexts: number;
  browserRunning: boolean;
  stealthAvailable: boolean;
  lastActivityAgoMs: number;
} {
  return {
    enabled: isPoolEnabled(),
    contexts: state.contexts.size,
    browserRunning: state.browser !== null,
    stealthAvailable: state.cloakLaunch !== null,
    lastActivityAgoMs: state.lastActivity === 0 ? -1 : Date.now() - state.lastActivity,
  };
}

/**
 * #3368 PR7 — browser-pool observability. Returns live status plus cumulative
 * lifecycle telemetry (launches, context create/reuse/evict/release counts,
 * failures, shutdowns). Surfaced via the omniroute_browser_pool_status MCP tool.
 */
export function getBrowserPoolMetrics(): {
  status: ReturnType<typeof getBrowserPoolStatus>;
  metrics: BrowserPoolMetrics;
} {
  return { status: getBrowserPoolStatus(), metrics: { ...state.metrics } };
}

/** Test-only: reset cumulative metrics so assertions start from a clean slate. */
export function __resetBrowserPoolMetricsForTest(): void {
  state.metrics = createBrowserPoolMetrics();
}

/** Test-only: expose internal state for reconnection tests. */
export function __getBrowserPoolStateForTest(): {
  browser: Browser | null;
  contextsCount: number;
  pendingCount: number;
  isAlive: boolean;
} {
  return {
    browser: state.browser,
    contextsCount: state.contexts.size,
    pendingCount: state.pendingContexts.size,
    isAlive: isBrowserAlive(),
  };
}

/** Test-only: simulate a browser disconnect (clears state as the event would). */
export function __simulateBrowserDisconnectForTest(): void {
  clearStaleBrowserState();
}

/** Test-only: set a fake browser in the pool state for testing. */
export function __setBrowserForTest(browser: Browser | null): void {
  state.browser = browser;
  if (browser) {
    browser.on("disconnected", () => {
      clearStaleBrowserState();
    });
  }
}

/** Test-only: classify an error for retry strategy. */
export function __classifyContextErrorForTest(err: unknown): string {
  return classifyContextError(err);
}

export async function readPageResponseBody(
  response: import("playwright").Response
): Promise<{ status: number; headers: Record<string, string>; body: Buffer<ArrayBuffer> }> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers())) {
    headers[name] = value;
  }
  const body = await response.body();
  return { status: response.status(), headers, body: Buffer.from(body) };
}
