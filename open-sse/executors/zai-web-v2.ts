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
  buildZaiNewChatBody,
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
   * No-op prompt fill. The prompt is sent directly via the API request body
   * in submitAndCapture, not through the UI textarea.
   */
  async fillPrompt(
    _page: Page,
    _messages: Array<{ role: string; content: unknown }>
  ): Promise<void> {
    // Intentionally empty — prompt is sent via API, not UI.
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
    const token = this.currentToken;
    if (!token) {
      return {
        status: 401,
        headers: {},
        body: "no token for z.ai completion",
        contentType: "text/plain",
      };
    }

    const modelId = this.currentModel || ZAI_DEFAULT_MODEL;
    const browserModel = browserModelName(modelId);
    const prompt = browserPrompt(this.currentMessages);
    const messages = this.currentMessages;

    // Build the proper chats/new body using the v1 protocol helper.
    // Z.ai expects a complex chat object with history, messages, models, etc.
    const { userMessageId, payload: newChatPayload } = buildZaiNewChatBody(
      messages,
      modelId,
      false,
      "high",
      { webSearchEnabled: false, toolsEnabled: false, websiteModeEnabled: false }
    );

    // Execute the entire two-step flow from within the browser page context.
    // This uses the browser's cookies, origin, and localStorage token.
    const result = await page.evaluate(
      async (params: {
        baseUrl: string;
        token: string;
        model: string;
        prompt: string;
        newChatPayload: Record<string, unknown>;
        userMessageId: string;
      }) => {
        const { baseUrl, token, model, prompt, newChatPayload, userMessageId } = params;

        // Step 1: Create a new chat with the proper body structure
        let chatId = "";
        try {
          const newChatResp = await fetch(`${baseUrl}/api/v1/chats/new`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(newChatPayload),
            credentials: "include",
          });
          const newChatText = await newChatResp.text();
          if (newChatResp.ok && newChatText.trim().startsWith("{")) {
            const chatData = JSON.parse(newChatText);
            chatId = typeof chatData?.id === "string" ? chatData.id : "";
          }
        } catch (err) {
          return {
            status: 502,
            headers: {} as Record<string, string>,
            body: `chats/new failed: ${err instanceof Error ? err.message : String(err)}`,
            contentType: "text/plain",
          };
        }

        if (!chatId) {
          return {
            status: 502,
            headers: {} as Record<string, string>,
            body: "chats/new returned no chat id",
            contentType: "text/plain",
          };
        }

        // Step 2: Try multiple completions endpoint variants.
        // Z.ai has changed this endpoint multiple times.
        const endpoints = [
          `${baseUrl}/api/v1/chat/completions`,
          `${baseUrl}/api/chat/completions`,
          `${baseUrl}/api/v2/chat/completions`,
        ];

        const reqBody = {
          stream: true,
          model,
          messages: [],
          chat_id: chatId,
          id: crypto.randomUUID(),
          current_user_message_id: userMessageId,
          current_user_message_parent_id: null,
          signature_prompt: prompt,
          params: {},
          extra: {},
          features: {
            image_generation: false,
            web_search: false,
            auto_web_search: false,
            preview_mode: true,
            flags: [],
            vlm_tools_enable: false,
            vlm_web_search_enable: false,
            vlm_website_mode: false,
            enable_thinking: false,
          },
          variables: {},
          background_tasks: {
            title_generation: true,
            tags_generation: true,
          },
          captcha_verify_param: "",
        };

        let lastError = "";
        for (const endpoint of endpoints) {
          try {
            const resp = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify(reqBody),
              credentials: "include",
            });
            const text = await resp.text();
            const respHeaders: Record<string, string> = {};
            resp.headers.forEach((value, name) => {
              respHeaders[name] = value;
            });

            if (resp.ok) {
              return {
                status: resp.status,
                headers: respHeaders,
                body: text,
                contentType: respHeaders["content-type"] || "text/event-stream",
              };
            }

            // If we get a non-404 error, it means the endpoint exists but
            // rejected our request — return that error rather than trying
            // other endpoints.
            if (resp.status !== 404) {
              return {
                status: resp.status,
                headers: respHeaders,
                body: text,
                contentType: respHeaders["content-type"] || "application/json",
              };
            }

            lastError = `${endpoint} -> ${resp.status}: ${text.slice(0, 100)}`;
          } catch (err) {
            lastError = `${endpoint} fetch failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        return {
          status: 404,
          headers: {} as Record<string, string>,
          body: `All completions endpoints returned 404. Last: ${lastError}`,
          contentType: "text/plain",
        };
      },
      {
        baseUrl: ZAI_BASE_URL,
        token,
        model: browserModel,
        prompt,
        newChatPayload,
        userMessageId,
      }
    );

    console.error(
      `[zai-web-v2] completions: status=${result.status} bodyLen=${result.body.length} preview=${result.body.slice(0, 200)}`
    );
    return result;
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
