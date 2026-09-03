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
import { getProviderUrl } from "../config/providerVersions.ts";
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
    return getProviderUrl("zai-web");
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
    await input.click();
    await page.keyboard.type(prompt, { delay: 5 });
  }

  async submitAndCapture(page: Page): Promise<WebCookieRawResponse> {
    const submit = page.locator(SUBMIT_SELECTOR).first();
    await submit.waitFor({ state: "visible", timeout: 10_000 });

    const responsePromise = page.waitForResponse(
      (r) => r.url().includes("/api/chat/completions") || r.url().includes("/api/v1/chats/new"),
      { timeout: 30_000 }
    );

    await submit.click();

    let response: Awaited<typeof responsePromise>;
    try {
      response = await responsePromise;
    } catch (error) {
      const message = error instanceof Error ? error.message : "submit capture failed";
      return { status: 502, headers: {}, body: message, contentType: "text/plain" };
    }

    const status = response.status();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers())) {
      headers[name] = value;
    }
    const body = await response.text().catch(() => "");
    const contentType = headers["content-type"] || "text/event-stream";
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
