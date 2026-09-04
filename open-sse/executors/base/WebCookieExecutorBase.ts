/**
 * WebCookieExecutorBase — Abstract base class for cookie/token-based web providers.
 *
 * LEV fork addition (Phase 6). Consolidates the shared lifecycle that every
 * browser-driven web-cookie executor reimplements: acquire a browser session
 * (Browserless CDP first, local browserPool fallback), navigate to the
 * provider URL, select the model, fill the prompt, submit, capture the
 * response, parse the provider-specific format, and clean up. Error
 * classification (404 model lockout, 429 rate limit, 401 session expired,
 * 502/503 provider error, empty-content STREAM_EARLY_EOF) is built in so
 * subclasses only describe provider-specific behavior.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  BaseExecutor,
  type ExecuteInput,
  type ExecutorExecuteResult,
  type ProviderConfig,
  type ProviderCredentials,
} from "../base.ts";
import {
  acquireBrowserContext,
  openPage,
  releaseBrowserContext,
  type BrowserPoolContextOptions,
  type PooledContext,
} from "../../services/browserPool.ts";
import { getBrowserlessWsUrl } from "../../services/sidecars.ts";
import {
  makeExecutorErrorResult as makeErrorResult,
  sanitizeErrorMessage,
} from "../../utils/error.ts";
import { classifyCaptcha, CaptchaType } from "../../services/captchaDetector.ts";

type Page = import("playwright").Page;
type BrowserContext = import("playwright").BrowserContext;
type Response = import("playwright").Response;

export type PromptFillStrategy = "svelte-evaluate" | "react-input" | "textarea";

export interface WebCookieProviderConfig {
  providerName: string;
  baseUrl: string;
  modelSelector: string;
  inputSelector: string;
  submitSelector: string;
  promptFillStrategy: PromptFillStrategy;
  cookieDomain: string;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  localStorage?: Record<string, string>;
  localStorageOrigin?: string;
  warmupUrl?: string;
  loginRedirectPatterns?: RegExp[];
  streamWatchdogMs?: number;
}

export interface WebCookieRawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType: string;
}

export interface WebCookieParsedResponse {
  content: string;
  reasoningContent?: string;
  finishReason?: string;
}

export type WebCookieExecuteResult =
  { response: Response; url: string } | { errorResult: ReturnType<typeof makeErrorResult> };

export type WebCookieErrorKind =
  | "MODEL_LOCKOUT"
  | "RATE_LIMIT"
  | "SESSION_EXPIRED"
  | "PROVIDER_ERROR"
  | "STREAM_EARLY_EOF"
  | "BROWSER_TRANSPORT"
  | "CAPTCHA_DETECTED"
  | "UNKNOWN";

export interface WebCookieError {
  kind: WebCookieErrorKind;
  status: number;
  message: string;
  retryAfterMs?: number;
}

export abstract class WebCookieExecutorBase extends BaseExecutor {
  protected providerConfig: WebCookieProviderConfig;

  private activeContexts = new Map<string, PooledContext>();

  constructor(
    provider: string,
    baseConfig: ProviderConfig,
    providerConfig: WebCookieProviderConfig
  ) {
    super(provider, baseConfig);
    this.providerConfig = providerConfig;
  }

  abstract getProviderUrl(): string;
  abstract selectModel(page: Page, model: string): Promise<void>;
  abstract fillPrompt(
    page: Page,
    messages: Array<{ role: string; content: unknown }>
  ): Promise<void>;
  abstract submitAndCapture(page: Page): Promise<WebCookieRawResponse>;
  abstract parseResponse(raw: WebCookieRawResponse): Promise<WebCookieParsedResponse>;

  protected resolvePoolKey(credentials: ProviderCredentials): string {
    const seed = String(credentials.apiKey ?? credentials.accessToken ?? "").trim();
    const hash = createHash("sha256")
      .update(seed || randomUUID())
      .digest("hex")
      .slice(0, 24);
    return `${this.provider}:${hash}`;
  }

  protected buildContextOptions(credentials: ProviderCredentials): BrowserPoolContextOptions {
    const cfg = this.providerConfig;
    const cookieString = String(credentials.apiKey ?? credentials.accessToken ?? "").trim();
    return {
      cookieDomain: cfg.cookieDomain,
      cookieString: cookieString.includes("=") ? cookieString : undefined,
      localStorage: cfg.localStorage,
      localStorageOrigin: cfg.localStorageOrigin,
      warmupUrl: cfg.warmupUrl ?? cfg.baseUrl,
      userAgent: cfg.userAgent,
      locale: cfg.locale,
      timezone: cfg.timezone,
    };
  }

  protected async acquireSession(
    credentials: ProviderCredentials
  ): Promise<{ page: Page; context: BrowserContext; pooled: PooledContext; key: string }> {
    const wsUrl = getBrowserlessWsUrl();
    if (wsUrl) {
      try {
        return await this.acquireBrowserlessSession(wsUrl, credentials);
      } catch (error) {
        void error;
      }
    }
    return this.acquireLocalSession(credentials);
  }

  protected async acquireLocalSession(
    credentials: ProviderCredentials
  ): Promise<{ page: Page; context: BrowserContext; pooled: PooledContext; key: string }> {
    const key = this.resolvePoolKey(credentials);
    const pooled = await acquireBrowserContext(key, this.buildContextOptions(credentials));
    this.activeContexts.set(key, pooled);
    const page = await openPage(pooled);
    return { page, context: pooled.context, pooled, key };
  }

  protected async acquireBrowserlessSession(
    _wsUrl: string,
    credentials: ProviderCredentials
  ): Promise<{ page: Page; context: BrowserContext; pooled: PooledContext; key: string }> {
    const key = `browserless:${this.resolvePoolKey(credentials)}`;
    const local = await this.acquireLocalSession(credentials);
    local.key = key;
    return local;
  }

  protected async validateSession(page: Page): Promise<boolean> {
    try {
      const url = page.url();
      if (this.providerConfig.loginRedirectPatterns) {
        for (const pattern of this.providerConfig.loginRedirectPatterns) {
          if (pattern.test(url)) return false;
        }
      }
      const loginIndicators = await page
        .locator('input[type="password"], [data-testid="login-form"], #login-form')
        .count()
        .catch(() => 0);
      return loginIndicators === 0;
    } catch {
      return true;
    }
  }

  protected async closeSession(key: string, page?: Page): Promise<void> {
    try {
      if (page) await page.close();
    } catch {
      // ignore
    }
    if (key.startsWith("browserless:")) return;
    const pooled = this.activeContexts.get(key);
    if (!pooled) return;
    this.activeContexts.delete(key);
    await releaseBrowserContext(key).catch(() => {});
  }

  protected classifyError(
    status: number,
    bodyText: string,
    retryAfter?: string | null
  ): WebCookieError {
    const message = sanitizeErrorMessage(bodyText || `HTTP ${status}`);

    // LEV fork: Detect captcha/Cloudflare challenges before other classifications.
    // This allows the caller to invoke the appropriate solver (NopeCHA extension,
    // cfClearanceService, or provider-specific solver) before giving up.
    const captcha = classifyCaptcha(bodyText);
    if (captcha.type !== CaptchaType.NONE) {
      return {
        kind: "CAPTCHA_DETECTED",
        status,
        message: `Captcha detected (${captcha.type}): ${message}`,
      };
    }

    if (status === 404) {
      return { kind: "MODEL_LOCKOUT", status, message: `Model not available: ${message}` };
    }
    if (status === 429) {
      const retryAfterMs = this.parseRetryAfterMs(retryAfter);
      return {
        kind: "RATE_LIMIT",
        status,
        message: `Rate limited: ${message}`,
        retryAfterMs,
      };
    }
    if (status === 401) {
      return { kind: "SESSION_EXPIRED", status, message: `Session expired: ${message}` };
    }
    if (status === 502 || status === 503) {
      return { kind: "PROVIDER_ERROR", status, message: `Provider error: ${message}` };
    }
    return { kind: "UNKNOWN", status, message };
  }

  protected parseRetryAfterMs(retryAfter?: string | null): number | undefined {
    if (!retryAfter) return undefined;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const dateMs = new Date(retryAfter).getTime();
    if (Number.isFinite(dateMs)) return Math.max(dateMs - Date.now(), 0);
    return undefined;
  }

  protected buildErrorFromClassification(
    error: WebCookieError,
    body: unknown,
    url: string
  ): ReturnType<typeof makeErrorResult> {
    const status =
      error.kind === "SESSION_EXPIRED"
        ? 503
        : error.kind === "MODEL_LOCKOUT"
          ? 404
          : error.kind === "STREAM_EARLY_EOF"
            ? 502
            : error.kind === "CAPTCHA_DETECTED"
              ? 403
              : error.status || 502;
    return makeErrorResult(status, `[${this.provider}] ${error.message}`, body, url);
  }

  protected async detectEmptyContent(
    parsed: WebCookieParsedResponse
  ): Promise<WebCookieError | null> {
    if (!parsed.content && !parsed.reasoningContent) {
      return {
        kind: "STREAM_EARLY_EOF",
        status: 502,
        message: "Upstream returned an empty response — session may be expired.",
      };
    }
    return null;
  }

  async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    const { body, model, signal, stream: wantStream } = input;
    const url = this.getProviderUrl();

    let session: { page: Page; context: BrowserContext; pooled: PooledContext; key: string };
    try {
      session = await this.acquireSession(input.credentials);
    } catch (error) {
      const message = sanitizeErrorMessage(
        error instanceof Error ? error.message : "browser transport unavailable"
      );
      return makeErrorResult(
        502,
        `[${this.provider}] browser session failed: ${message}`,
        body,
        url
      );
    }

    const { page, key } = session;
    try {
      if (signal?.aborted) throw new Error("request aborted before navigation");
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

      const authenticated = await this.validateSession(page);
      if (!authenticated) {
        return this.buildErrorFromClassification(
          { kind: "SESSION_EXPIRED", status: 401, message: "Browser landed on login wall." },
          body,
          url
        );
      }

      await this.selectModel(page, model);
      const messages =
        ((body as Record<string, unknown> | null)?.messages as Array<{
          role: string;
          content: unknown;
        }>) || [];
      await this.fillPrompt(page, messages);

      const raw = await this.submitAndCapture(page);
      if (raw.status < 200 || raw.status >= 300) {
        const retryAfter = raw.headers["retry-after"];
        const error = this.classifyError(raw.status, raw.body, retryAfter);
        return this.buildErrorFromClassification(error, body, url);
      }

      const parsed = await this.parseResponse(raw);
      const emptyError = await this.detectEmptyContent(parsed);
      if (emptyError) {
        return this.buildErrorFromClassification(emptyError, body, url);
      }

      const id = `chatcmpl-${this.provider}-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const message: Record<string, unknown> = { role: "assistant", content: parsed.content };
      if (parsed.reasoningContent) message.reasoning_content = parsed.reasoningContent;
      const completion = {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message, finish_reason: parsed.finishReason ?? "stop" }],
      };

      if (wantStream) {
        const encoder = new TextEncoder();
        const streamBody = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: parsed.content },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`
              )
            );
            if (parsed.reasoningContent) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { reasoning_content: parsed.reasoningContent },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`
                )
              );
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: parsed.finishReason ?? "stop" }],
                })}\n\n`
              )
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return {
          response: new Response(streamBody, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          }),
          url,
        };
      }

      return {
        response: new Response(JSON.stringify(completion), {
          headers: { "Content-Type": "application/json" },
        }),
        url,
      };
    } catch (error) {
      const message = sanitizeErrorMessage(
        error instanceof Error ? error.message : "web-cookie execution failed"
      );
      return makeErrorResult(502, `[${this.provider}] execution failed: ${message}`, body, url);
    } finally {
      await this.closeSession(key, page).catch(() => {});
    }
  }
}
