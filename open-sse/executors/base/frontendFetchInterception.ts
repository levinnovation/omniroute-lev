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
  beforeFetch?: (page: Page) => Promise<void>;
  log?: ExecutorLog | null;
  signal?: AbortSignal | null;
}

export interface FrontendFetchResult {
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
}

interface BrowserFetchResult {
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
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
  fetchOptions: RequestInit
): Promise<BrowserFetchResult> {
  const options = serializeFetchOptions(fetchOptions);
  return page.evaluate(
    async ({ url, init }) => {
      const response = await fetch(url, init as RequestInit);
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
    },
    { url: fetchUrl, init: options }
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
    beforeFetch,
    log,
    signal,
  } = config;
  const contextKey = `${poolKey}:ffi:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  let acquired = false;
  let page: Page | null = null;

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
    await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 30_000 });
    throwIfAborted(signal);

    if (beforeFetch) await beforeFetch(page);
    throwIfAborted(signal);

    const fetchUrl =
      typeof config.fetchUrl === "function" ? await config.fetchUrl(page) : config.fetchUrl;
    const fetchOptions =
      typeof config.fetchOptions === "function"
        ? await config.fetchOptions(page)
        : config.fetchOptions;

    if (responseUrlMatch) {
      const responsePromise = page.waitForResponse(
        (response) => matchesResponseUrl(response.url(), responseUrlMatch),
        { timeout: responseTimeoutMs }
      );
      const [, intercepted] = await Promise.all([
        executePageFetch(page, fetchUrl, fetchOptions),
        responsePromise,
      ]);
      const result = await readInterceptedResponse(intercepted);
      log?.info?.(providerName.toUpperCase(), `FFI completed with HTTP ${result.status}`);
      return result;
    }

    const result = await executePageFetch(page, fetchUrl, fetchOptions);
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
  return false;
}

export const isFrontendJSCrash = shouldFallbackToFFI;
