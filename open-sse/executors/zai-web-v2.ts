/**
 * ZaiWebExecutorV2 — Z.ai consumer chat via the WebCookieExecutorBase.
 *
 * LEV fork addition (Phase 6). Extends the consolidated base class instead of
 * reimplementing the browser lifecycle. Used when OMNIROUTE_EXECUTOR_V2=on;
 * the original zai-web.ts remains the default fallback.
 *
 * Architecture: The browser page provides the authenticated session (cookies,
 * localStorage token, origin). All API calls are made from page.evaluate() to
 * use that session context. UI interaction (model selector, prompt fill,
 * submit click) is bypassed because z.ai's SPA UI changes frequently and breaks
 * DOM-based interaction. This is still browser-first per LEV Hard Rule #1 — the
 * browser is the auth and execution context, not direct HTTP from Node.
 */
import type { Page } from "playwright";
import {
  WebCookieExecutorBase,
  type WebCookieRawResponse,
  type WebCookieParsedResponse,
} from "./base/WebCookieExecutorBase.ts";
import type { BrowserPoolContextOptions } from "../services/browserPool.ts";
import type { ProviderCredentials, ExecuteInput } from "../base.ts";
import {
  browserModelName,
  browserPrompt,
  ZAI_BASE_URL,
  ZAI_DEFAULT_MODEL,
  ZAI_USER_AGENT,
  ZAI_CHAT_URL,
  ZAI_NEW_CHAT_URL,
  ZAI_DEFAULT_FE_VERSION,
  ZAI_DEFAULT_CLIENT_VERSION,
} from "./zai-web/protocol.ts";
import { parseZaiFrame, isZaiVersionOutdatedError } from "./zai-web/stream.ts";
import { ZAI_WEB_SESSION_CONFIG } from "./zai-web/sessionConfig.ts";
import { WebSessionDriver } from "../services/webSessionDriver.ts";
import { interceptFrontendFetch, shouldFallbackToFFI, type FrontendFetchConfig } from "./base/frontendFetchInterception.ts";
import { makeExecutorErrorResult as makeErrorResult } from "../utils/error.ts";

const INPUT_SELECTOR = "#chat-input";
const SUBMIT_SELECTOR = '[aria-label="Send Message"] button:not([disabled])';
const MODEL_SELECTOR = '[aria-label="Select a model"]';

export class ZaiWebExecutorV2 extends WebCookieExecutorBase {
  private sessionDriver = new WebSessionDriver(ZAI_WEB_SESSION_CONFIG);
  /** Stored per-request for use in submitAndCapture's two-step flow. */
  private currentToken = "";
  private currentModel = "";
  private currentMessages: Array<{ role: string; content: unknown }> = [];
  private currentSignal: AbortSignal | null = null;
  private currentCredentials: ProviderCredentials | null = null;

  constructor() {
    super(
      "zai-web",
      { id: "zai-web", baseUrl: ZAI_BASE_URL },
      {
        providerName: "zai-web",
        baseUrl: ZAI_BASE_URL,
        modelSelector: MODEL_SELECTOR,
        inputSelector: INPUT_SELECTOR,
        submitSelector: SUBMIT_SELECTOR,
        promptFillStrategy: "svelte-evaluate",
        cookieDomain: "chat.z.ai",
        userAgent: ZAI_USER_AGENT,
        locale: "en-US",
        timezone: "Asia/Seoul",
        localStorage: {},
        localStorageOrigin: ZAI_BASE_URL,
        warmupUrl: ZAI_BASE_URL,
        loginRedirectPatterns: ZAI_WEB_SESSION_CONFIG.loginRedirectPatterns,
        streamWatchdogMs: ZAI_WEB_SESSION_CONFIG.streamWatchdogMs,
      }
    );
  }

  /**
   * Override execute to capture request context (token, model, messages, signal)
   * before the base class runs. submitAndCapture needs these for the two-step
   * Z.ai flow: capture chats/new from the browser, then direct-fetch the SSE
   * stream from the completions endpoint.
   *
   * LEV fork GAP-7: If the base class execute() fails with a Browserless
   * disconnect or JS crash, fall back to FFI (frontend fetch interception).
   */
  async execute(input: ExecuteInput): Promise<import("../base.ts").ExecutorExecuteResult> {
    this.currentToken = String(
      input.credentials?.apiKey ?? input.credentials?.accessToken ?? ""
    ).trim();
    this.currentCredentials = input.credentials ?? null;
    this.currentModel = input.model || ZAI_DEFAULT_MODEL;
    this.currentMessages =
      ((input.body as Record<string, unknown> | null)?.messages as Array<{
        role: string;
        content: unknown;
      }>) || [];
    this.currentSignal = input.signal ?? null;

    try {
      const result = await super.execute(input);
      if (
        result &&
        typeof result === "object" &&
        "status" in result &&
        (result as { status: number }).status >= 500
      ) {
        const errBody = String((result as { body?: unknown }).body ?? "");
        // Check for Browserless disconnect patterns OR zai-web-specific
        // symptoms of disconnect (no completions response captured = page closed)
        const isDisconnect =
          shouldFallbackToFFI(errBody) ||
          errBody.includes("did not send a completions request") ||
          errBody.includes("no completions response captured") ||
          errBody.includes("page may have navigated away");
        if (isDisconnect) {
          console.error("[zai-web-v2] base execute failed with Browserless disconnect, trying FFI fallback");
          const ffiResult = await this.executeViaFFI(input);
          if (ffiResult) return ffiResult;
        }
      }
      return result;
    } catch (err) {
      const isDisconnect =
        shouldFallbackToFFI(err) ||
        (err instanceof Error && err.message.includes("Target page, context or browser has been closed"));
      if (isDisconnect) {
        console.error(
          `[zai-web-v2] base execute threw Browserless disconnect: ${
            err instanceof Error ? err.message : String(err)
          }, trying FFI fallback`
        );
        const ffiResult = await this.executeViaFFI(input);
        if (ffiResult) return ffiResult;
      }
      throw err;
    }
  }

  /**
   * LEV fork GAP-7: FFI fallback — make the API call from within a fresh
   * browser context using page.evaluate(fetch(...)). This bypasses the UI
   * interaction that fails when Browserless disconnects mid-operation.
   */
  private async executeViaFFI(
    input: ExecuteInput
  ): Promise<import("../base.ts").ExecutorExecuteResult | null> {
    const token = this.currentToken;
    if (!token) return null;

    const cookieString = token.includes("=") ? token : "";
    const prompt = browserPrompt(this.currentMessages);
    const modelId = browserModelName(this.currentModel);

    const ffiConfig: FrontendFetchConfig = {
      providerName: "zai-web",
      poolKey: `zai-web-ffi:${token.slice(0, 24)}`,
      pageUrl: `${ZAI_BASE_URL}/?model=${encodeURIComponent(modelId)}`,
      cookieDomain: "chat.z.ai",
      cookieString,
      userAgent: ZAI_USER_AGENT,
      localStorage: { token },
      localStorageOrigin: ZAI_BASE_URL,
      fetchUrl: async (page) => {
        const newChatRes = await page.evaluate(async (url: string) => {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "New Chat", model: "GLM-5.1" }),
          });
          return { status: r.status, body: await r.text() };
        }, ZAI_NEW_CHAT_URL);
        let chatId = "ffi-chat";
        try {
          const data = JSON.parse(newChatRes.body);
          chatId = data?.id ?? data?.data?.id ?? chatId;
        } catch {}
        return `${ZAI_CHAT_URL}?chat_id=${chatId}`;
      },
      fetchOptions: async () => ({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-client-version": ZAI_DEFAULT_CLIENT_VERSION,
          "x-fe-version": ZAI_DEFAULT_FE_VERSION,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: prompt }],
          stream: true,
        }),
      }),
      responseUrlMatch: /\/api\/chat\/completions/,
      responseTimeoutMs: 60_000,
      log: input.log,
      signal: this.currentSignal,
    };

    const ffiResult = await interceptFrontendFetch(ffiConfig);
    if (!ffiResult) return null;

    const parsed = await this.parseResponse({
      status: ffiResult.status,
      headers: ffiResult.headers,
      body: ffiResult.body,
      contentType: ffiResult.contentType,
    });

    if (!parsed.content && !parsed.reasoningContent) return null;

    const completionBody = {
      id: `zai-web-ffi-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: this.currentModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: parsed.content,
            reasoning_content: parsed.reasoningContent || undefined,
          },
          finish_reason: parsed.finishReason || "stop",
        },
      ],
    };

    return {
      response: new Response(JSON.stringify(completionBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      url: ZAI_CHAT_URL,
    } as import("../base.ts").ExecutorExecuteResult;
  }

  getProviderUrl(): string {
    // Navigate to the chat page with a model query param, not the bare root.
    // The bare root (https://chat.z.ai) matches loginRedirectPatterns and
    // causes validateSession() to falsely report a login wall even when the
    // token is valid. The v1 executor navigates to /?model=... for the same
    // reason.
    return `${ZAI_BASE_URL}/?model=${encodeURIComponent(browserModelName(ZAI_DEFAULT_MODEL))}`;
  }

  /**
   * Override buildContextOptions to inject the JWT token into localStorage.
   *
   * Z.ai's web app reads `localStorage.token` at boot to authenticate. The
   * base class only handles cookie strings (looking for `=`), but zai-web
   * credentials are JWT tokens (containing `.`), so the base class leaves
   * them un-injected. Without this override, the browser navigates to
   * chat.z.ai with no auth and lands on the login wall.
   */
  protected buildContextOptions(credentials: ProviderCredentials): BrowserPoolContextOptions {
    const base = super.buildContextOptions(credentials);
    const token = String(credentials.apiKey ?? credentials.accessToken ?? "").trim();
    if (token) {
      base.localStorage = { ...(base.localStorage ?? {}), token };
    }
    return base;
  }

  /**
   * No-op model selection. The browser page provides the authenticated
   * session; we bypass the UI model selector because z.ai's SPA changes
   * frequently and breaks DOM-based interaction. The model is passed
   * directly in the API request body.
   */
  async selectModel(_page: Page, _model: string): Promise<void> {
    // Intentionally empty — model is set in the API request body, not the UI.
  }

  /**
   * Fill the prompt using keyboard.type() to ensure Svelte reactivity.
   * The evaluate-based approach sets textarea.value but doesn't trigger
   * Svelte's bind:value, so the submit button stays disabled.
   */
  async fillPrompt(page: Page, messages: Array<{ role: string; content: unknown }>): Promise<void> {
    const prompt = browserPrompt(messages);
    const input = page.locator(INPUT_SELECTOR).first();
    await input.waitFor({ state: "visible", timeout: 15_000 });

    // Click the input with an explicit timeout and fallbacks.
    // The default Playwright click timeout is 30s — if the SPA hasn't fully
    // initialized event handlers (or an overlay covers the input), the click
    // hangs for 30s and then fails. Use a shorter timeout with evaluate fallback.
    try {
      await input.click({ timeout: 10_000 });
    } catch {
      try {
        await input.evaluate((el) => (el as HTMLElement).focus());
        console.error("[zai-web-v2] fillPrompt: click failed, used focus() fallback");
      } catch {
        console.error("[zai-web-v2] fillPrompt: click and focus both failed, typing anyway");
      }
    }
    await page.keyboard.type(prompt, { delay: 5 });
    await page.waitForTimeout(500);
  }

  /**
   * Intercept the frontend's own completions response.
   *
   * The frontend already:
   *   1. Creates a chat (POST /api/v1/chats/new)
   *   2. Solves the Aliyun Captcha itself
   *   3. Sends the completions request (POST /api/chat/completions)
   *   4. Receives the SSE stream
   *
   * We intercept the completions response (step 4) and capture the SSE stream.
   * This avoids needing to solve the captcha ourselves, which was failing
   * because the Browserless sidecar disconnects during the long page.evaluate()
   * call required by the Aliyun captcha solver.
   *
   * This is browser-first per LEV Hard Rule #1 — the browser provides the auth
   * context and the frontend handles the captcha + completions request.
   */
  async submitAndCapture(page: Page): Promise<WebCookieRawResponse> {
    const token = this.currentToken;
    if (!token) {
      return {
        status: 401,
        headers: {},
        body: "no token for z.ai completion",
        contentType: "text/plain",
      };
    }

    // Wait for the page to fully load.
    try {
      await page.waitForLoadState("networkidle", { timeout: 15_000 });
    } catch {
      // Continue even if networkidle doesn't fire
    }
    // Give the Svelte SPA a moment to initialize event handlers after networkidle.
    // Without this, the input element exists and is visible but not yet clickable
    // (the click action times out because Svelte hasn't bound event listeners yet).
    await page.waitForTimeout(1000);

    // Set up the response listener BEFORE submitting to capture the
    // frontend's own completions response.
    // The frontend solves the Aliyun Captcha itself and sends the completions
    // request to /api/v2/chat/completions. We intercept that response.
    let completionsResponse: import("playwright").Response | null = null;
    let capturedChatId = "";

    const responsePromise = page
      .waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          (r.url().includes("/api/chat/completions") ||
            r.url().includes("/api/v1/chat/completions") ||
            r.url().includes("/api/v2/chat/completions")),
        { timeout: 90_000 }
      )
      .then((r) => {
        completionsResponse = r;
        return r;
      })
      .catch(() => null);

    // Also capture the chat ID for diagnostics
    page.on("response", (response) => {
      const url = response.url();
      if (url.includes("/api/v1/chats/new")) {
        response
          .text()
          .then((text) => {
            try {
              const data = JSON.parse(text);
              if (typeof data?.id === "string") {
                capturedChatId = data.id;
                console.error(`[zai-web-v2] captured chat ID: ${capturedChatId}`);
              }
            } catch {}
            console.error(
              `[zai-web-v2] chats/new response: status=${response.status()} body=${text.slice(0, 200)}`
            );
          })
          .catch(() => {});
      }
    });

    // Submit the prompt via the UI to trigger the frontend's chat creation
    const submitSelectors = [
      SUBMIT_SELECTOR,
      'button[type="submit"]',
      'button[aria-label*="Send"]',
      'button[data-testid*="submit"]',
      "button.send-btn",
      "form button:not([disabled])",
    ];
    const input = page.locator(INPUT_SELECTOR).first();

    // Diagnostic
    const inputCount = await input.count();
    let submitCount = 0;
    let matchedSelector = "";
    for (const sel of submitSelectors) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        submitCount = count;
        matchedSelector = sel;
        break;
      }
    }
    console.error(
      `[zai-web-v2] submit diag: inputCount=${inputCount} submitCount=${submitCount} matchedSel=${matchedSelector || "none"}`
    );

    // Try clicking the submit button
    if (submitCount > 0 && matchedSelector) {
      const submit = page.locator(matchedSelector).first();
      try {
        await submit.click({ timeout: 5_000 });
        console.error(`[zai-web-v2] submit: clicked button (${matchedSelector})`);
      } catch {
        try {
          await submit.evaluate((el) => (el as HTMLElement).click());
          console.error(`[zai-web-v2] submit: evaluate-clicked button (${matchedSelector})`);
        } catch {
          console.error(`[zai-web-v2] submit: button click failed, trying Enter`);
          await input.click().catch(() => {});
          await page.keyboard.press("Enter");
        }
      }
    } else {
      await input.click().catch(() => {});
      await page.keyboard.press("Enter");
      console.error(`[zai-web-v2] submit: pressed Enter`);
    }

    // Wait for the frontend's completions response
    console.error("[zai-web-v2] waiting for frontend completions response...");
    await responsePromise;

    if (!completionsResponse) {
      console.error("[zai-web-v2] no completions response captured");
      return {
        status: 502,
        headers: {},
        body: "z.ai frontend did not send a completions request — the page may have navigated away or the session expired",
        contentType: "text/plain",
      };
    }

    // Read the SSE stream from the frontend's completions response
    const status = completionsResponse.status();
    const contentType = completionsResponse.headers()["content-type"] || "text/event-stream";
    let body = "";
    try {
      body = await completionsResponse.text();
    } catch (err) {
      console.error(
        `[zai-web-v2] failed to read completions body: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return {
        status: 502,
        headers: {},
        body: `failed to read z.ai completions response: ${
          err instanceof Error ? err.message : String(err)
        }`,
        contentType: "text/plain",
      };
    }

    const respHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(completionsResponse.headers())) {
      respHeaders[name] = value;
    }

    console.error(
      `[zai-web-v2] completions: status=${status} bodyLen=${body.length} chatId=${capturedChatId ? "yes" : "no"} preview=${body.slice(0, 200)}`
    );

    return {
      status,
      headers: respHeaders,
      body,
      contentType,
    };
  }

  async parseResponse(raw: WebCookieRawResponse): Promise<WebCookieParsedResponse> {
    let content = "";
    let reasoningContent = "";
    let finishReason = "stop";

    const lines = raw.body.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.replace(/^data:\s*/, "").trim();
      if (payload === "[DONE]") {
        finishReason = "stop";
        break;
      }
      try {
        const frame = JSON.parse(payload);
        const parsed = parseZaiFrame(frame);
        if (parsed.content) content += parsed.content;
        if (parsed.reasoningContent) reasoningContent += parsed.reasoningContent;
        if (parsed.finishReason) finishReason = parsed.finishReason;
      } catch {
        // Non-JSON SSE line, skip
      }
    }

    // If no SSE lines were found, try parsing as JSON (non-streaming response)
    if (!content && !reasoningContent && raw.body.trim().startsWith("{")) {
      try {
        const json = JSON.parse(raw.body);
        const choice = json?.choices?.[0];
        if (choice?.message?.content) {
          content = String(choice.message.content);
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
      } catch {
        // Not JSON either — return raw body as content
        content = raw.body;
      }
    }

    if (isZaiVersionOutdatedError(raw.body)) {
      return {
        content: "",
        reasoningContent: "",
        finishReason: "error",
        error: {
          status: 400,
          message: "Z.ai client version outdated",
        },
      };
    }

    return { content, reasoningContent, finishReason };
  }
}
