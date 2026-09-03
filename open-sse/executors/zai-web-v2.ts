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
} from "./zai-web/protocol.ts";
import { parseZaiFrame, isZaiVersionOutdatedError } from "./zai-web/stream.ts";
import { ZAI_WEB_SESSION_CONFIG } from "./zai-web/sessionConfig.ts";
import { WebSessionDriver } from "../services/webSessionDriver.ts";

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
    return super.execute(input);
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
    await input.click();
    await page.keyboard.type(prompt, { delay: 5 });
    await page.waitForTimeout(500);
  }

  /**
   * Two-step Z.ai completion flow, executed entirely from the browser page
   * context to use the authenticated session (cookies, localStorage token,
   * origin). Bypasses the UI entirely.
   *
   * Step 1: POST to /api/v1/chats/new to create a chat and get a chat ID.
   * Step 2: POST to the completions endpoint with the chat ID and prompt.
   *
   * Z.ai has changed their completions endpoint multiple times. We try
   * multiple path variants to find the working one.
   */
  async submitAndCapture(page: Page): Promise<WebCookieRawResponse> {
    // Set up a response listener to capture the completions SSE response.
    // Z.ai's frontend sends the completions request with a CAPTCHA proof
    // that we can't generate ourselves. By using the browser UI to submit,
    // the frontend handles CAPTCHA naturally.
    let capturedResponse: {
      status: number;
      headers: Record<string, string>;
      body: string;
      contentType: string;
    } | null = null;

    const responsePromise = page
      .waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          (r.url().includes("/api/v1/chat/completions") ||
            r.url().includes("/api/chat/completions") ||
            r.url().includes("/api/v2/chat/completions")),
        { timeout: 60_000 }
      )
      .then(async (response) => {
        const status = response.status();
        const respHeaders: Record<string, string> = {};
        response.headers().forEach((value, name) => {
          respHeaders[name] = value;
        });
        // Wait for the response body to finish streaming
        await Promise.race([
          response.finished().then(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 30_000)),
        ]);
        const body = await response.text().catch(() => "");
        const contentType = respHeaders["content-type"] || "text/event-stream";
        console.error(
          `[zai-web-v2] captured completions: status=${status} bodyLen=${body.length} preview=${body.slice(0, 200)}`
        );
        capturedResponse = { status, headers: respHeaders, body, contentType };
      })
      .catch((err) => {
        console.error(
          `[zai-web-v2] completions capture failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });

    // Submit the prompt via the UI. The browser's frontend will handle
    // CAPTCHA, cookies, and session context naturally.
    const submit = page.locator(SUBMIT_SELECTOR).first();
    const input = page.locator(INPUT_SELECTOR).first();

    // Try clicking the submit button first
    let submitted = false;
    if ((await submit.count()) > 0) {
      try {
        await submit.click({ timeout: 5_000 });
        submitted = true;
      } catch {
        // Click failed — try evaluate-based click
        try {
          await submit.evaluate((el) => (el as HTMLElement).click());
          submitted = true;
        } catch {
          // Fall through to Enter key
        }
      }
    }

    if (!submitted) {
      // Focus the input and press Enter
      await input.click().catch(() => {});
      await page.keyboard.press("Enter");
    }

    // Wait for the completions response
    await responsePromise;

    if (capturedResponse) {
      return capturedResponse;
    }

    return {
      status: 502,
      headers: {},
      body: "No completions response captured — the browser may not have sent the message",
      contentType: "text/plain",
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
