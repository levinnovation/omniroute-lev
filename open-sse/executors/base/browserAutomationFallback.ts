/**
 * browserAutomationFallback.ts — Shared browser-automation transport for
 * web-cookie executors.
 *
 * LEV fork addition (Phase 6). Provides a generic `runBrowserAutomation()`
 * helper that acquires a browser session via the shared browserPool (which
 * connects to the Browserless sidecar first, falling back to a local
 * patchright/playwright launch), navigates to a provider's web UI, fills the
 * prompt, submits, and captures the upstream response via Playwright's
 * `page.waitForResponse()`.
 *
 * Each web-cookie executor wraps this helper in a thin `executeViaBrowser()`
 * method that maps the captured raw response into the executor's output
 * format. The existing direct-HTTP path remains as the fallback when
 * `OMNIROUTE_BROWSER_POOL=off` or when browser automation fails.
 */
import {
  acquireBrowserContext,
  openPage,
  releaseBrowserContext,
  type BrowserPoolContextOptions,
} from "../../services/browserPool.ts";
import { sanitizeErrorMessage } from "../../utils/error.ts";
import type { ExecutorLog } from "../base.ts";
import {
  interceptFrontendFetch,
  shouldFallbackToFFI,
  type FrontendFetchConfig,
} from "./frontendFetchInterception.ts";

type Page = import("playwright").Page;

export interface BrowserAutomationConfig {
  providerName: string;
  poolKey: string;
  pageUrl: string;
  cookieDomain: string;
  cookieString?: string | null;
  localStorage?: Record<string, string>;
  localStorageOrigin?: string;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  inputSelector: string;
  submitSelector?: string;
  submitButtonMode?: "dom" | "playwright";
  prompt: string;
  responseUrlMatch: RegExp | ((url: string) => boolean);
  responseTimeoutMs?: number;
  postSubmitWaitMs?: number;
  beforeSubmit?: (page: Page) => Promise<void>;
  fillMode?: "evaluate" | "fill" | "type";
  log?: ExecutorLog | null;
  signal?: AbortSignal | null;
  reuseContext?: boolean;
  frontendFetchConfig?: FrontendFetchConfig;
}

export interface BrowserAutomationResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType: string;
}

function isPoolDisabled(): boolean {
  return process.env.OMNIROUTE_BROWSER_POOL === "off";
}

function matchesResponseUrl(url: string, match: RegExp | ((url: string) => boolean)): boolean {
  if (match instanceof RegExp) return match.test(url);
  return match(url);
}

function waitWithSignal(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fillPrompt(
  page: Page,
  selector: string,
  prompt: string,
  mode: "evaluate" | "fill" | "type",
  signal?: AbortSignal | null
): Promise<void> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 10_000 });
  if (mode === "type") {
    await page.keyboard.type(prompt, { delay: 5 });
    return;
  }
  if (mode === "evaluate") {
    try {
      await locator.evaluate((el, text) => {
        const textarea = el as HTMLTextAreaElement;
        textarea.value = text;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
      }, prompt);
    } catch {
      await locator.fill(prompt);
    }
    return;
  }
  await locator.fill(prompt);
  void signal;
}

/**
 * Acquire a browser session, navigate to the provider UI, fill the prompt,
 * submit, and capture the upstream response. Returns `null` when the pool is
 * disabled or when the browser automation fails for any reason so the caller
 * can fall back to the direct-HTTP path.
 */
export async function runBrowserAutomation(
  config: BrowserAutomationConfig
): Promise<BrowserAutomationResult | null> {
  if (isPoolDisabled()) return null;
  const {
    providerName,
    poolKey,
    pageUrl,
    cookieDomain,
    cookieString,
    localStorage,
    localStorageOrigin,
    userAgent,
    locale,
    timezone,
    inputSelector,
    submitSelector,
    submitButtonMode = "playwright",
    prompt,
    responseUrlMatch,
    responseTimeoutMs = 30_000,
    postSubmitWaitMs = 15_000,
    beforeSubmit,
    fillMode = "evaluate",
    log,
    signal,
    reuseContext = true,
    frontendFetchConfig,
  } = config;

  const contextKey = reuseContext
    ? poolKey
    : `${poolKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const options: BrowserPoolContextOptions = {
    cookieDomain,
    cookieString: cookieString || undefined,
    localStorage,
    localStorageOrigin,
    warmupUrl: pageUrl,
    userAgent,
    locale,
    timezone,
  };

  let pooled;
  try {
    pooled = await acquireBrowserContext(contextKey, options);
  } catch (err) {
    log?.warn?.(
      providerName.toUpperCase(),
      `Browser automation: context acquire failed: ${sanitizeErrorMessage(err instanceof Error ? err.message : String(err))}`
    );
    return null;
  }

  let page: Page | null = null;
  let ffiFallbackError: unknown = null;
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    page = await openPage(pooled);
    // LEV fork: fail fast when Browserless disconnects mid-request instead of
    // hanging until the local execution deadline or Browserless timeout.
    const browser = pooled.context.browser();
    const disconnectPromise = new Promise<null>((resolve) => {
      if (browser) {
        browser.on("disconnected", () => resolve(null));
      }
    });
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitWithSignal(1500, signal);

    if (beforeSubmit) {
      await beforeSubmit(page);
      await waitWithSignal(500, signal);
    }

    await fillPrompt(page, inputSelector, prompt, fillMode, signal);
    await waitWithSignal(800, signal);

    const responsePromise = page.waitForResponse(
      (r) => r.request().method() === "POST" && matchesResponseUrl(r.url(), responseUrlMatch),
      { timeout: responseTimeoutMs }
    );

    if (submitSelector) {
      const btn = page.locator(submitSelector).first();
      if ((await btn.count()) > 0) {
        try {
          if (submitButtonMode === "dom") {
            await btn.evaluate((element) => (element as HTMLElement).click());
          } else {
            await btn.click({ timeout: 2000 });
          }
        } catch {
          await page.keyboard.press("Enter");
        }
      } else {
        await page.keyboard.press("Enter");
      }
    } else {
      await page.keyboard.press("Enter");
    }

    // LEV fork: race the response against browser disconnect — if Browserless
    // dies mid-wait, return null immediately so the caller can fall back.
    const response = await Promise.race([responsePromise.catch(() => null), disconnectPromise]);
    if (!response) {
      log?.warn?.(providerName.toUpperCase(), "Browser automation: no response captured");
      return null;
    }

    await Promise.race([
      response.finished().then(() => undefined),
      waitWithSignal(Math.min(postSubmitWaitMs, 30_000), signal),
    ]);

    const status = response.status();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers())) {
      headers[name] = value;
    }
    const body = await response.text().catch(() => "");
    const contentType = headers["content-type"] || "text/event-stream";
    return { status, headers, body, contentType };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    log?.warn?.(
      providerName.toUpperCase(),
      `Browser automation failed: ${sanitizeErrorMessage(err instanceof Error ? err.message : String(err))}`
    );
    if (frontendFetchConfig && shouldFallbackToFFI(err)) ffiFallbackError = err;
  } finally {
    try {
      if (page) await page.close();
    } catch {
      // ignore
    }
    if (!reuseContext || ffiFallbackError) {
      try {
        await releaseBrowserContext(contextKey);
      } catch {
        // ignore
      }
    }
  }

  if (ffiFallbackError && frontendFetchConfig) {
    log?.info?.(
      providerName.toUpperCase(),
      `Browser automation failed with an FFI-eligible error; retrying through frontend fetch`
    );
    return interceptFrontendFetch(frontendFetchConfig);
  }
  return null;
}

/**
 * Gate helper — returns true when the browser pool is enabled (Browserless or
 * local fallback active). Executors use this to decide whether to attempt the
 * browser-automation path before the direct-HTTP fallback.
 */
export function isBrowserAutomationEnabled(): boolean {
  return !isPoolDisabled();
}
