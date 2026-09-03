/**
 * ZaiWebExecutorV2 — Z.ai consumer chat via the WebCookieExecutorBase.
 *
 * LEV fork addition (Phase 6). Extends the consolidated base class instead of
 * reimplementing the browser lifecycle. Used when OMNIROUTE_EXECUTOR_V2=on;
 * the original zai-web.ts remains the default fallback.
 */
import type { Page } from "playwright";
import {
  WebCookieExecutorBase,
  type WebCookieRawResponse,
  type WebCookieParsedResponse,
} from "./base/WebCookieExecutorBase.ts";
import type { BrowserPoolContextOptions } from "../services/browserPool.ts";
import type { ProviderCredentials } from "../base.ts";
import {
  browserModelName,
  browserPrompt,
  ZAI_BASE_URL,
  ZAI_DEFAULT_MODEL,
  ZAI_USER_AGENT,
} from "./zai-web/protocol.ts";
import { parseZaiFrame, isZaiVersionOutdatedError } from "./zai-web/stream.ts";
import { configureZaiBrowserRequest } from "./zai-web/browserAutomation.ts";
import { ZAI_WEB_SESSION_CONFIG } from "./zai-web/sessionConfig.ts";
import { WebSessionDriver } from "../services/webSessionDriver.ts";

const INPUT_SELECTOR = "#chat-input";
const SUBMIT_SELECTOR = '[aria-label="Send Message"] button:not([disabled])';
const MODEL_SELECTOR = '[aria-label="Select a model"]';

export class ZaiWebExecutorV2 extends WebCookieExecutorBase {
  private sessionDriver = new WebSessionDriver(ZAI_WEB_SESSION_CONFIG);

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

  async selectModel(page: Page, model: string): Promise<void> {
    const modelName = browserModelName(model || ZAI_DEFAULT_MODEL);
    // Wait for the SPA to render the chat UI before trying to interact.
    // The base class navigates with waitUntil:"domcontentloaded" which fires
    // before the Svelte app hydrates and renders the model selector.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.locator(INPUT_SELECTOR).first().waitFor({ state: "visible", timeout: 15_000 });
    await configureZaiBrowserRequest(page, {
      modelId: model || ZAI_DEFAULT_MODEL,
      thinking: { enabled: false, supported: false, effortSupported: false, effort: "high" },
      vlm: { webSearchEnabled: false, toolsEnabled: false, websiteModeEnabled: false },
    });
    void modelName;
  }

  async fillPrompt(page: Page, messages: Array<{ role: string; content: unknown }>): Promise<void> {
    const prompt = browserPrompt(messages);
    const input = page.locator(INPUT_SELECTOR).first();
    await input.waitFor({ state: "visible", timeout: 10_000 });
    // Use evaluate mode to set the textarea value and dispatch Svelte-reactive
    // input/change events. keyboard.type() is slow for long prompts and may
    // not trigger Svelte's reactivity properly, leaving the submit button
    // disabled. This matches the v1 executor's fillMode: "evaluate".
    try {
      await input.evaluate((el, text) => {
        const textarea = el as HTMLTextAreaElement;
        textarea.value = text;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
      }, prompt);
    } catch {
      await input.fill(prompt);
    }
  }

  async submitAndCapture(page: Page): Promise<WebCookieRawResponse> {
    const submit = page.locator(SUBMIT_SELECTOR).first();
    await submit.waitFor({ state: "visible", timeout: 15_000 });

    // Wait for Svelte to react to the prompt fill and enable the submit button.
    // The v1 executor waits 800ms after fillPrompt before clicking.
    await page.waitForTimeout(800);

    const responsePromise = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().includes("/api/chat/completions"),
      { timeout: 30_000 }
    );

    // Use evaluate-based click to avoid coordinate interception by the
    // landing-page hero animation overlay (matches v1 submitButtonMode: "dom").
    // Fall back to Enter key if the submit button is disabled or not found.
    if ((await submit.count()) > 0) {
      try {
        await submit.evaluate((el) => (el as HTMLElement).click());
      } catch {
        await page.keyboard.press("Enter");
      }
    } else {
      await page.keyboard.press("Enter");
    }

    let response: Awaited<typeof responsePromise>;
    try {
      response = await responsePromise;
    } catch (error) {
      const message = error instanceof Error ? error.message : "submit capture failed";
      return { status: 502, headers: {}, body: message, contentType: "text/plain" };
    }

    // Wait for the SSE stream to finish before reading the body.
    // response.text() on an unfinished streaming response returns an empty
    // string. The v1 executor uses response.finished() + postSubmitWaitMs.
    await Promise.race([
      response.finished().then(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 30_000)),
    ]);

    const status = response.status();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers())) {
      headers[name] = value;
    }
    const body = await response.text().catch(() => "");
    const contentType = headers["content-type"] || "text/event-stream";
    // Diagnostic: log captured response details to help debug empty responses.
    console.error(
      `[zai-web-v2] submitAndCapture: url=${response.url()} status=${status} ct=${contentType} bodyLen=${body.length} bodyPreview=${body.slice(0, 200)}`
    );
    return { status, headers, body, contentType };
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
        const delta = parseZaiFrame(frame);
        if (!delta) continue;
        if (delta.error) {
          content = delta.error;
          finishReason = "stop";
          break;
        }
        if (delta.content) content += delta.content;
        if (delta.reasoning) reasoningContent += delta.reasoning;
        if (delta.done) {
          finishReason = "stop";
          break;
        }
      } catch {
        // skip non-JSON lines
      }
    }

    if (!content && !reasoningContent && raw.body.trim().startsWith("{")) {
      try {
        const json = JSON.parse(raw.body);
        const choices = json?.choices as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(choices) && choices.length > 0) {
          const message = (choices[0]?.message ?? {}) as Record<string, unknown>;
          content = typeof message.content === "string" ? message.content : "";
          reasoningContent =
            typeof message.reasoning_content === "string" ? message.reasoning_content : "";
        }
      } catch {
        // not JSON either
      }
    }

    if (isZaiVersionOutdatedError(content)) {
      return { content: "", reasoningContent: "", finishReason: "stop" };
    }

    return { content, reasoningContent, finishReason };
  }
}

export function isV2Enabled(): boolean {
  return process.env.OMNIROUTE_EXECUTOR_V2 === "on";
}
