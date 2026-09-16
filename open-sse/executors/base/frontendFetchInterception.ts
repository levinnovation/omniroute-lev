/**
 * frontendFetchInterception.ts — Browser-context fetch transport for web-cookie providers.
 *
 * Frontend Fetch Interception (FFI) establishes an authenticated browser session, then performs
 * the provider's internal API request from inside that page. It is used as a primary transport
 * by providers whose UI cannot be automated reliably and as a fallback when DOM automation
 * crashes or Browserless disconnects mid-operation.
 */
import {
  acquireBrowserContext,
  openPage,
  releaseBrowserContext,
  type BrowserPoolContextOptions,
  type PooledContext,
} from "../../services/browserPool.ts";
import { sanitizeErrorMessage } from "../../utils/error.ts";
import type { ExecutorLog } from "../base.ts";

type Page = import("playwright").Page;
type PlaywrightResponse = import("playwright").Response;

export interface FrontendFetchConfig {
  providerName: string;
  poolKey: string;
  pageUrl: string;
  cookieDomain: string;
  cookieString: string;
  userAgent: string;
  localStorage?: Record<string, string>;
  localStorageOrigin?: string;
  fetchUrl: string | ((page: Page) => Promise<string>);
  fetchOptions: RequestInit | ((page: Page) => Promise<RequestInit>);
  responseUrlMatch?: RegExp | ((url: string) => boolean);
  responseTimeoutMs: number;
  /**
   * Navigation wait condition. Defaults to "domcontentloaded" — the same
   * condition runBrowserAutomation uses. Do NOT default this to "networkidle":
   * chat SPAs hold persistent connections (websockets, long-polling, telemetry
   * beacons) so the network never goes idle, and page.goto then burns its full
   * timeout and fails. Only set "networkidle" for a provider proven to reach it.
   */
  waitUntil?: "domcontentloaded" | "load" | "networkidle" | "commit";
  beforeFetch?: (page: Page) => Promise<void>;
  log?: ExecutorLog | null;
  signal?: AbortSignal | null;
  /**
   * LEV fork Phase 2: Use CDP-level network capture instead of
   * page.waitForResponse(). Attaches context-level response listeners before
   * navigation, avoiding the race where waitForResponse misses early
   * responses (the listener attaches after the response already arrived).
   * Defaults to false for backward compatibility; enable for providers whose
   * responses arrive before waitForResponse can attach.
   */
  useCdpCapture?: boolean;
  /**
   * LEV fork Phase 2: Optional request interception via page.route().
   * When provided, routes matching the URL pattern are intercepted and the
   * handler can modify headers, block telemetry, or add auth headers.
   */
  routeInterception?: RouteInterceptionConfig;
  /**
   * LEV fork Phase 2: Enable network request logging for debugging.
   * When true, all requests/responses are collected and returned in the
   * result's networkLog field. Useful for diagnosing missed responses.
   */
  logNetwork?: boolean;
}

/** LEV fork Phase 2: Request interception configuration. */
export interface RouteInterceptionConfig {
  /** URL pattern to match for interception. */
  urlPattern: string | RegExp;
  /**
   * Handler for intercepted requests. Call route.continue() to forward,
   * route.fulfill() to short-circuit, or route.abort() to block.
   */
  handler: (
    route: import("playwright").Route,
    request: import("playwright").Request
  ) => Promise<void>;
}

/** LEV fork Phase 2: A captured network request/response pair. */
export interface NetworkLogEntry {
  url: string;
  method: string;
  status: number;
  method_response: string;
  contentType: string;
  timestamp: number;
}

export interface FrontendFetchResult {
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
  /** LEV fork Phase 2: network log when logNetwork is enabled. */
  networkLog?: NetworkLogEntry[];
}

interface BrowserFetchResult {
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
  /** LEV fork Phase 2: network log when logNetwork is enabled. */
  networkLog?: NetworkLogEntry[];
}

interface FrontendFetchDependencies {
  acquireBrowserContext: (
    key: string,
    options: BrowserPoolContextOptions
  ) => Promise<PooledContext>;
  openPage: (pooled: PooledContext) => Promise<Page>;
  releaseBrowserContext: (key: string) => Promise<void>;
}

const defaultDependencies: FrontendFetchDependencies = {
  acquireBrowserContext,
  openPage,
  releaseBrowserContext,
};

let dependencies = defaultDependencies;

/** Test-only dependency seam; production always uses the browser pool functions above. */
export function __setFrontendFetchDependenciesForTest(
  overrides: Partial<FrontendFetchDependencies>
): void {
  dependencies = { ...defaultDependencies, ...overrides };
}

export function __resetFrontendFetchDependenciesForTest(): void {
  dependencies = defaultDependencies;
}

function matchesResponseUrl(
  url: string,
  match: RegExp | ((candidate: string) => boolean)
): boolean {
  if (match instanceof RegExp) {
    match.lastIndex = 0;
    return match.test(url);
  }
  return match(url);
}

function headersToRecord(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) result[name.toLowerCase()] = value;
  return result;
}

function serializeFetchOptions(options: RequestInit): Record<string, unknown> {
  const headers = new Headers(options.headers);
  const serializable: Record<string, unknown> = {
    method: options.method,
    headers: Object.fromEntries(headers.entries()),
    body: typeof options.body === "string" ? options.body : undefined,
    cache: options.cache,
    credentials: options.credentials,
    integrity: options.integrity,
    keepalive: options.keepalive,
    mode: options.mode,
    redirect: options.redirect,
    referrer: options.referrer,
    referrerPolicy: options.referrerPolicy,
  };
  return Object.fromEntries(
    Object.entries(serializable).filter(([, value]) => value !== undefined)
  );
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function executePageFetch(
  page: Page,
  fetchUrl: string,
  fetchOptions: RequestInit,
  timeoutMs: number
): Promise<BrowserFetchResult> {
  const options = serializeFetchOptions(fetchOptions);
  return page.evaluate(
    async ({ url, init, timeout }) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, { ...(init as RequestInit), signal: controller.signal });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          headers[name] = value;
        });
        return {
          status: response.status,
          body: await response.text(),
          contentType: response.headers.get("content-type") || "application/octet-stream",
          headers,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
    { url: fetchUrl, init: options, timeout: timeoutMs }
  );
}

async function readInterceptedResponse(response: PlaywrightResponse): Promise<FrontendFetchResult> {
  await response.finished().catch(() => null);
  const headers = headersToRecord(response.headers());
  return {
    status: response.status(),
    body: await response.text().catch(() => ""),
    contentType: headers["content-type"] || "application/octet-stream",
    headers,
  };
}

// ── LEV fork Phase 2: CDP-level network capture ────────────────────────────
//
// Ported from Patchright Enhanced's CDP network capture technique.
// page.waitForResponse() attaches a listener that can miss responses that
// arrive before the listener is registered (race condition on fast providers).
// Context-level response listeners are attached before navigation, so they
// capture every response from the moment the context is created.

interface CdpCaptureState {
  capturedResponse: PlaywrightResponse | null;
  networkLog: NetworkLogEntry[];
  cleanup: () => void;
}

/**
 * Attach context-level request/response listeners for CDP-style network
 * capture. The listeners are attached to the BrowserContext (not the Page),
 * so they fire for every page in the context — including responses that
 * arrive before page.waitForResponse() could attach.
 *
 * Returns a state object with the captured response, network log, and a
 * cleanup function that removes the listeners.
 */
function attachCdpNetworkCapture(
  page: Page,
  responseUrlMatch: RegExp | ((url: string) => boolean) | undefined,
  logNetwork: boolean
): CdpCaptureState {
  const context = page.context();
  const capturedResponse: { value: PlaywrightResponse | null } = { value: null };
  const networkLog: NetworkLogEntry[] = [];

  const onResponse = (response: PlaywrightResponse) => {
    const url = response.url();
    if (logNetwork) {
      try {
        networkLog.push({
          url,
          method: response.request().method(),
          status: response.status(),
          method_response: "response",
          contentType: response.headers()["content-type"] || "",
          timestamp: Date.now(),
        });
      } catch {
        // response may be detached; skip
      }
    }
    if (capturedResponse.value) return; // already captured
    if (responseUrlMatch && matchesResponseUrl(url, responseUrlMatch)) {
      capturedResponse.value = response;
    }
  };

  context.on("response", onResponse);

  return {
    get capturedResponse() {
      return capturedResponse.value;
    },
    networkLog,
    cleanup() {
      context.off("response", onResponse);
    },
  } as unknown as CdpCaptureState;
}

/**
 * LEV fork Phase 2: Set up request interception via page.route() if configured.
 * This allows modifying requests (add auth headers, block telemetry) before
 * they are sent. Ported from Patchright Enhanced's route interception pattern.
 */
async function setupRouteInterception(page: Page, config: RouteInterceptionConfig): Promise<void> {
  await page.route(config.urlPattern, async (route, request) => {
    try {
      await config.handler(route, request);
    } catch {
      // handler error — fall through to default (continue)
      await route.continue().catch(() => {});
    }
  });
}

/**
 * LEV fork Phase 2: Wait for a CDP-captured response with a timeout.
 * Polls the capture state for the target response, resolving when found
 * or rejecting on timeout. This avoids the waitForResponse race condition.
 */
async function waitForCdpResponse(
  capture: CdpCaptureState,
  timeoutMs: number,
  signal?: AbortSignal | null
): Promise<PlaywrightResponse> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<PlaywrightResponse>((resolve, reject) => {
    const check = () => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      if (capture.capturedResponse) {
        resolve(capture.capturedResponse);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`CDP capture timeout after ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

/**
 * Perform an authenticated frontend fetch in a fresh browser context.
 *
 * The unique context key is intentional: fallback callers commonly arrive here because the
 * original page/context/browser died, so reusing that pool entry would immediately repeat the
 * same failure.
 */
export async function interceptFrontendFetch(
  config: FrontendFetchConfig
): Promise<FrontendFetchResult | null> {
  const {
    providerName,
    poolKey,
    pageUrl,
    cookieDomain,
    cookieString,
    userAgent,
    localStorage,
    localStorageOrigin,
    responseUrlMatch,
    responseTimeoutMs,
    waitUntil = "domcontentloaded",
    beforeFetch,
    log,
    signal,
    useCdpCapture = false,
    routeInterception,
    logNetwork = false,
  } = config;
  const contextKey = `${poolKey}:ffi:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  let acquired = false;
  let page: Page | null = null;
  let cdpCapture: CdpCaptureState | null = null;

  try {
    throwIfAborted(signal);
    const pooled = await dependencies.acquireBrowserContext(contextKey, {
      cookieDomain,
      cookieString: cookieString || undefined,
      localStorage,
      localStorageOrigin,
      warmupUrl: pageUrl,
      userAgent,
    });
    acquired = true;
    page = await dependencies.openPage(pooled);

    // LEV fork Phase 2: Set up request interception before navigation so
    // we can modify headers/block telemetry for requests fired during goto.
    if (routeInterception) {
      await setupRouteInterception(page, routeInterception);
    }

    // LEV fork Phase 2: Attach CDP-level network capture before navigation.
    // Context-level listeners fire for every response, including ones that
    // arrive before page.waitForResponse() could attach its listener.
    if (useCdpCapture || logNetwork) {
      cdpCapture = attachCdpNetworkCapture(page, responseUrlMatch, logNetwork);
    }

    await page.goto(pageUrl, { waitUntil, timeout: 30_000 });
    throwIfAborted(signal);

    if (beforeFetch) await beforeFetch(page);
    throwIfAborted(signal);

    const fetchUrl =
      typeof config.fetchUrl === "function" ? await config.fetchUrl(page) : config.fetchUrl;
    const fetchOptions =
      typeof config.fetchOptions === "function"
        ? await config.fetchOptions(page)
        : config.fetchOptions;

    if (responseUrlMatch && useCdpCapture && cdpCapture) {
      // LEV fork Phase 2: CDP-level capture path. The context listener was
      // attached before navigation, so it captures responses that
      // page.waitForResponse() would miss due to the attach race.
      const [, intercepted] = await Promise.all([
        executePageFetch(page, fetchUrl, fetchOptions, responseTimeoutMs),
        waitForCdpResponse(cdpCapture, responseTimeoutMs, signal),
      ]);
      const result = await readInterceptedResponse(intercepted);
      if (logNetwork) result.networkLog = cdpCapture.networkLog;
      log?.info?.(providerName.toUpperCase(), `FFI (CDP) completed with HTTP ${result.status}`);
      return result;
    }

    if (responseUrlMatch) {
      const responsePromise = page.waitForResponse(
        (response) => matchesResponseUrl(response.url(), responseUrlMatch),
        { timeout: responseTimeoutMs }
      );
      const [, intercepted] = await Promise.all([
        executePageFetch(page, fetchUrl, fetchOptions, responseTimeoutMs),
        responsePromise,
      ]);
      const result = await readInterceptedResponse(intercepted);
      if (logNetwork && cdpCapture) result.networkLog = cdpCapture.networkLog;
      log?.info?.(providerName.toUpperCase(), `FFI completed with HTTP ${result.status}`);
      return result;
    }

    const result = await executePageFetch(page, fetchUrl, fetchOptions, responseTimeoutMs);
    if (logNetwork && cdpCapture) result.networkLog = cdpCapture.networkLog;
    log?.info?.(providerName.toUpperCase(), `FFI completed with HTTP ${result.status}`);
    return result;
  } catch (err) {
    if (isAbortError(err)) throw err;
    log?.warn?.(
      providerName.toUpperCase(),
      `FFI failed: ${sanitizeErrorMessage(err instanceof Error ? err.message : String(err))}`
    );
    return null;
  } finally {
    cdpCapture?.cleanup();
    if (page) await page.close().catch(() => {});
    if (acquired) await dependencies.releaseBrowserContext(contextKey).catch(() => {});
  }
}

export function shouldFallbackToFFI(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Cannot access") && message.includes("before initialization")) return true;
  if (message.includes("Cannot read properties of") && message.includes("undefined")) return true;
  if (message.includes("Cannot set properties of") && message.includes("undefined")) return true;
  if (message.includes("Target page, context or browser has been closed")) return true;
  if (message.includes("Target closed") && message.toLowerCase().includes("browser")) return true;
  // A composer that never appears is exactly the case FFI exists for: the page
  // and its session are fine, only the DOM automation is unusable (the provider
  // shipped a UI change, or the logged-in layout differs from the one the
  // selector was written against). Falling through to direct HTTP instead
  // throws away the authenticated browser context — the whole reason we opened
  // a browser. Observed on perplexity-web as a 10s locator.waitFor timeout on
  // every single request.
  if (message.includes("locator.waitFor") && message.includes("Timeout")) return true;
  if (message.includes("waiting for locator") && message.includes("exceeded")) return true;
  return false;
}

export const isFrontendJSCrash = shouldFallbackToFFI;
