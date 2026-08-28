/**
 * ZaiWebExecutor — Z.ai consumer chat (chat.z.ai).
 *
 * The consumer frontend stores a Bearer JWT in localStorage and requires a
 * browser-issued CAPTCHA proof for chat completions. The browser transport is
 * the default; callers with a short-lived proof can use the direct HTTP path.
 *
 * Completions go to /api/chat/completions; the older versioned
 * /api/v2/chat/completions path is deprecated and silently ignores the
 * client version param, causing "client version (unknown) is outdated" errors.
 */
import { createHash, randomUUID } from "node:crypto";
import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { configureZaiBrowserRequest } from "./zai-web/browserAutomation.ts";
import {
  asRecord,
  browserModelName,
  browserPrompt,
  buildZaiCompletionUrl,
  buildZaiHeaders,
  buildZaiNewChatBody,
  buildZaiRequestBody,
  buildZaiSignature,
  collectZaiImageUrls,
  describeZaiBrowserFailure,
  extractZaiToken,
  extractZaiUserId,
  foldMessages,
  getZaiModelCapabilities,
  latestUserPrompt,
  parseZaiClientVersion,
  parseZaiFrontendVersion,
  resolveZaiCaptchaVerifyParam,
  resolveZaiThinkingConfig,
  resolveZaiVlmConfig,
  unprefixedModelId,
  zaiImageFileName,
  ZAI_BASE_URL,
  ZAI_CHAT_URL,
  ZAI_DEFAULT_CLIENT_VERSION,
  ZAI_DEFAULT_FE_VERSION,
  ZAI_DEFAULT_MODEL,
  ZAI_FE_VERSION_CACHE_TTL_MS,
  ZAI_NEW_CHAT_URL,
  ZAI_USER_AGENT,
  type ZaiReasoningEffort,
  type ZaiThinkingConfig,
  type ZaiVlmConfig,
} from "./zai-web/protocol.ts";
import {
  buildZaiStreamingBody,
  collectZaiNonStreaming,
  isZaiVersionOutdatedError,
  makeZaiChunkEmitter,
} from "./zai-web/stream.ts";
import { browserBackedChat } from "../services/browserBackedChat.ts";
import { CursorImageError, resolveCursorImages } from "../utils/cursorImages.ts";
import {
  makeExecutorErrorResult as makeErrorResult,
  sanitizeErrorMessage,
} from "../utils/error.ts";
// LEV fork: WebSessionDriver for robust cookie-based session management
import { WebSessionDriver } from "../services/webSessionDriver.ts";
import { ZAI_WEB_SESSION_CONFIG } from "./zai-web/sessionConfig.ts";

export {
  buildZaiSignature,
  describeZaiBrowserFailure,
  extractZaiCaptchaVerifyParam,
  extractZaiToken,
  extractZaiUserId,
  foldMessages,
  getZaiModelCapabilities,
  parseZaiFrontendVersion,
  resolveZaiThinkingConfig,
  resolveZaiVlmConfig,
} from "./zai-web/protocol.ts";
export type {
  ZaiModelCapabilities,
  ZaiReasoningEffort,
  ZaiThinkingConfig,
  ZaiVlmConfig,
} from "./zai-web/protocol.ts";
export { parseZaiFrame } from "./zai-web/stream.ts";
export type { ZaiDelta } from "./zai-web/stream.ts";

let cachedFeVersion: { value: string; expiresAt: number } | null = null;
let cachedClientVersion: { value: string; expiresAt: number } | null = null;

type ZaiBrowserAttachments = NonNullable<Parameters<typeof browserBackedChat>[0]["attachments"]>;

/** Decode the request's image URLs into browser upload attachments. */
async function resolveZaiBrowserAttachments(
  imageUrls: string[],
  body: unknown
): Promise<
  { attachments: ZaiBrowserAttachments } | { errorResult: ReturnType<typeof makeErrorResult> }
> {
  try {
    // Browser-page upload: keep the original bytes/mimeType (no Cursor wire prep).
    // EncodedImage.mimeType is optional on the wire type, but every producer
    // reachable here (decodeDataUrl / fetchImageBytes) validates an image/*
    // string before pushing; the fallback only satisfies the attachment type.
    const images = await resolveCursorImages(imageUrls, { prepareForWire: false });
    return {
      attachments: images.map((image, index) => {
        const mimeType = image.mimeType ?? "image/jpeg";
        return {
          name: zaiImageFileName(mimeType, index),
          mimeType,
          buffer: image.data,
        };
      }),
    };
  } catch (error) {
    const message =
      error instanceof CursorImageError
        ? error.message
        : sanitizeErrorMessage(error instanceof Error ? error.message : "invalid image input");
    return {
      errorResult: makeErrorResult(
        error instanceof CursorImageError ? error.status : 400,
        `Z.ai image input error: ${message}`,
        body,
        ZAI_CHAT_URL
      ),
    };
  }
}

/**
 * The call-log body for a browser-transport turn. There is no real upstream
 * request payload to record here, so this reconstructs the equivalent shape the
 * signed-API path logs, from the settings the browser UI was driven with.
 */
function buildZaiBrowserAuditBody(input: {
  messages: Array<{ role: string; content: unknown }>;
  modelId: string;
  thinkingConfig: ZaiThinkingConfig;
  vlmConfig: ZaiVlmConfig;
  imageCount: number;
}): Record<string, unknown> {
  const { thinkingConfig: thinking, vlmConfig: vlm } = input;
  return {
    browser_backed: true,
    image_count: input.imageCount,
    model: input.modelId,
    messages: foldMessages(input.messages),
    enable_thinking: thinking.enabled,
    auto_web_search: vlm.websiteModeEnabled ? false : vlm.webSearchEnabled,
    vlm_tools_enable: vlm.toolsEnabled,
    vlm_web_search_enable: vlm.websiteModeEnabled && vlm.webSearchEnabled,
    vlm_website_mode: vlm.websiteModeEnabled,
    ...(thinking.enabled && thinking.effortSupported ? { reasoning_effort: thinking.effort } : {}),
  };
}

/**
 * Drive-the-real-UI options for chat.z.ai: which selectors to type into and click,
 * and the localStorage token the page reads at boot. `beforeSubmit` flips the
 * Deep Think / web-search / tools switches to match the request.
 */
function buildZaiBrowserChatOptions(input: {
  attachments: ZaiBrowserAttachments;
  messages: Array<{ role: string; content: unknown }>;
  modelId: string;
  signal?: AbortSignal | null;
  thinkingConfig: ZaiThinkingConfig;
  token: string;
  vlmConfig: ZaiVlmConfig;
}): Parameters<typeof browserBackedChat>[0] {
  const poolKey = `zai-web:${createHash("sha256").update(input.token).digest("hex").slice(0, 24)}`;
  // LEV fork: Z.ai's browser frontend POSTs to /api/v1/chats/new to create a
  // chat, then fetches the SSE stream from /api/chat/completions. Watch for the
  // chat creation endpoint so the browser transport can intercept its response.
  return {
    poolKey,
    chatUrl: ZAI_NEW_CHAT_URL,
    chatPageUrl: `${ZAI_BASE_URL}/?model=${encodeURIComponent(browserModelName(input.modelId))}`,
    userMessage: browserPrompt(input.messages),
    localStorage: { token: input.token },
    localStorageOrigin: ZAI_BASE_URL,
    cookieDomain: "chat.z.ai",
    chatUrlMatchDomain: "chat.z.ai",
    userAgent: ZAI_USER_AGENT,
    locale: "en-US",
    timezone: "Asia/Seoul",
    inputSelector: "#chat-input",
    submitButtonSelector: '[aria-label="Send Message"] button:not([disabled])',
    submitButtonMode: "dom",
    attachments: input.attachments,
    beforeSubmit: (page) =>
      configureZaiBrowserRequest(page, {
        modelId: input.modelId,
        thinking: input.thinkingConfig,
        vlm: input.vlmConfig,
      }),
    postSubmitWaitMs: 30_000,
    signal: input.signal,
    reuseContext: true,
  };
}

/** What either transport hands back: the upstream stream plus its call-log pair. */
type ZaiTransportResult = {
  upstream: Response;
  auditHeaders: Record<string, string>;
  auditBody: Record<string, unknown>;
};

type ZaiResolvedRequest = {
  captchaVerifyParam: string;
  imageUrls: string[];
  messages: Array<{ role: string; content: unknown }>;
  modelId: string;
  prompt: string;
  thinkingConfig: ZaiThinkingConfig;
  token: string;
  userId: string;
  vlmConfig: ZaiVlmConfig;
};

/**
 * Validate the credential and body, and resolve everything both transports need.
 *
 * All four rejections are client errors that must never reach the upstream: no
 * usable session token, no user turn, an image sent to a text-only model, and a
 * JWT with no user id (which the signed-API path needs to build its signature).
 */
function resolveZaiRequest(
  input: ExecuteInput
): { request: ZaiResolvedRequest } | { errorResult: ReturnType<typeof makeErrorResult> } {
  const { body, credentials, model } = input;
  const bodyObj = (body || {}) as Record<string, unknown>;
  const fail = (message: string) => ({
    errorResult: makeErrorResult(400, message, body, ZAI_CHAT_URL),
  });

  const rawCredential = String(credentials?.apiKey ?? credentials?.accessToken ?? "").trim();
  const token = extractZaiToken(rawCredential);
  if (!token) {
    return fail(
      'Missing Z.ai web-session credential — copy the "token" value from chat.z.ai Local Storage.'
    );
  }

  const messages = (bodyObj.messages as Array<{ role: string; content: unknown }>) || [];
  const prompt = latestUserPrompt(messages);
  const imageUrls = collectZaiImageUrls(messages);
  if (!prompt && imageUrls.length === 0) {
    return fail("Z.ai requires at least one user message");
  }

  const modelId = (bodyObj.model as string) || model || ZAI_DEFAULT_MODEL;
  if (imageUrls.length > 0 && !getZaiModelCapabilities(modelId).vision) {
    return fail(
      `Z.ai model ${unprefixedModelId(modelId)} does not accept image input; use GLM-5V-Turbo.`
    );
  }

  const userId = extractZaiUserId(token);
  if (!userId) {
    return fail(
      "Invalid Z.ai web-session credential — its JWT payload does not contain the required user id."
    );
  }

  return {
    request: {
      captchaVerifyParam: resolveZaiCaptchaVerifyParam(credentials, bodyObj),
      imageUrls,
      messages,
      modelId,
      prompt,
      thinkingConfig: resolveZaiThinkingConfig(modelId, bodyObj),
      token,
      userId,
      vlmConfig: resolveZaiVlmConfig(modelId, bodyObj),
    },
  };
}

export class ZaiWebExecutor extends BaseExecutor {
  // LEV fork: WebSessionDriver for pre-dispatch validation, stream watchdog,
  // empty-content detection, and login-redirect detection.
  private sessionDriver = new WebSessionDriver(ZAI_WEB_SESSION_CONFIG);

  constructor() {
    super("zai-web", { id: "zai-web", baseUrl: ZAI_BASE_URL });
  }

  private async resolveFrontendVersion(signal?: AbortSignal | null): Promise<string> {
    if (cachedFeVersion && cachedFeVersion.expiresAt > Date.now()) {
      return cachedFeVersion.value;
    }
    let version = ZAI_DEFAULT_FE_VERSION;
    try {
      const response = await fetch(`${ZAI_BASE_URL}/`, {
        headers: { Accept: "text/html", "User-Agent": ZAI_USER_AGENT },
        signal,
      });
      if (response.ok) {
        const html = await response.text();
        version = parseZaiFrontendVersion(html) ?? version;
        // Also try to extract the client app version from the same HTML fetch
        // to avoid a second round-trip.
        const clientVersion = parseZaiClientVersion(html);
        if (clientVersion) {
          cachedClientVersion = {
            value: clientVersion,
            expiresAt: Date.now() + ZAI_FE_VERSION_CACHE_TTL_MS,
          };
        }
      }
    } catch {
      // The current verified version remains a safe fallback when homepage probing fails.
    }
    cachedFeVersion = {
      value: version,
      expiresAt: Date.now() + ZAI_FE_VERSION_CACHE_TTL_MS,
    };
    return version;
  }

  private async resolveClientVersion(signal?: AbortSignal | null): Promise<string> {
    if (cachedClientVersion && cachedClientVersion.expiresAt > Date.now()) {
      return cachedClientVersion.value;
    }
    let version = ZAI_DEFAULT_CLIENT_VERSION;
    try {
      const response = await fetch(`${ZAI_BASE_URL}/`, {
        headers: { Accept: "text/html", "User-Agent": ZAI_USER_AGENT },
        signal,
      });
      if (response.ok) {
        version = parseZaiClientVersion(await response.text()) ?? version;
      }
    } catch {
      // Fall back to the hardcoded default when homepage probing fails.
    }
    cachedClientVersion = {
      value: version,
      expiresAt: Date.now() + ZAI_FE_VERSION_CACHE_TTL_MS,
    };
    return version;
  }

  /** Invalidate the cached client version so the next call re-fetches from Z.ai. */
  private invalidateClientVersion(): void {
    cachedClientVersion = null;
  }

  private async createRemoteChat(input: {
    messages: Array<{ role: string; content: unknown }>;
    modelId: string;
    token: string;
    enableThinking: boolean;
    reasoningEffort: ZaiReasoningEffort;
    vlmConfig: ZaiVlmConfig;
    signal?: AbortSignal | null;
    originalBody: unknown;
    frontendVersion?: string;
    clientVersion?: string;
  }): Promise<
    { chatId: string; userMessageId: string } | { errorResult: ReturnType<typeof makeErrorResult> }
  > {
    const { userMessageId, payload } = buildZaiNewChatBody(
      input.messages,
      input.modelId,
      input.enableThinking,
      input.reasoningEffort,
      input.vlmConfig
    );
    let response: Response;
    try {
      response = await fetch(ZAI_NEW_CHAT_URL, {
        method: "POST",
        headers: buildZaiHeaders(input.token, {
          accept: "application/json",
          frontendVersion: input.frontendVersion,
          clientVersion: input.clientVersion,
        }),
        body: JSON.stringify(payload),
        signal: input.signal,
      });
    } catch (error) {
      const message = sanitizeErrorMessage(
        error instanceof Error ? error.message : "unknown network error"
      );
      return {
        errorResult: makeErrorResult(
          502,
          `Z.ai chat creation failed: ${message}`,
          input.originalBody,
          ZAI_NEW_CHAT_URL
        ),
      };
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return {
        errorResult: makeErrorResult(
          response.status,
          `Z.ai chat creation error: ${sanitizeErrorMessage(errorText)}`,
          input.originalBody,
          ZAI_NEW_CHAT_URL
        ),
      };
    }
    const result = asRecord(await response.json().catch(() => null));
    const chatId = typeof result?.id === "string" ? result.id : "";
    if (!chatId) {
      return {
        errorResult: makeErrorResult(
          502,
          "Z.ai chat creation returned no chat id",
          input.originalBody,
          ZAI_NEW_CHAT_URL
        ),
      };
    }
    return { chatId, userMessageId };
  }

  private async fetchUpstream(
    completionUrl: string,
    reqHeaders: Record<string, string>,
    reqBody: Record<string, unknown>,
    body: unknown,
    signal: AbortSignal | null | undefined
  ): Promise<{ upstream: Response } | { errorResult: ReturnType<typeof makeErrorResult> }> {
    let upstream: Response;
    try {
      upstream = await fetch(completionUrl, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify(reqBody),
        signal,
      });
    } catch (error) {
      const message = sanitizeErrorMessage(
        error instanceof Error ? error.message : "unknown network error"
      );
      return {
        errorResult: makeErrorResult(502, `Z.ai fetch failed: ${message}`, body, ZAI_CHAT_URL),
      };
    }

    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => "");
      return {
        errorResult: makeErrorResult(
          upstream.status,
          `Z.ai error: ${sanitizeErrorMessage(errorText)}`,
          body,
          ZAI_CHAT_URL
        ),
      };
    }
    return { upstream };
  }

  private async fetchThroughBrowser(input: {
    body: unknown;
    messages: Array<{ role: string; content: unknown }>;
    modelId: string;
    imageUrls: string[];
    signal?: AbortSignal | null;
    thinkingConfig: ZaiThinkingConfig;
    token: string;
    vlmConfig: ZaiVlmConfig;
  }): Promise<ZaiTransportResult | { errorResult: ReturnType<typeof makeErrorResult> }> {
    const resolved = await resolveZaiBrowserAttachments(input.imageUrls, input.body);
    if ("errorResult" in resolved) return resolved;
    const { attachments } = resolved;

    // LEV fork: Resolve client + frontend versions so the direct fetch to
    // /api/chat/completions sends them. Without these, Z.ai returns
    // "[Z.ai error] Your client version (unknown) is outdated."
    const frontendVersion = await this.resolveFrontendVersion(input.signal);
    const clientVersion = await this.resolveClientVersion(input.signal);

    let result: Awaited<ReturnType<typeof browserBackedChat>>;
    try {
      result = await browserBackedChat(buildZaiBrowserChatOptions({ ...input, attachments }));
    } catch (error) {
      const message = sanitizeErrorMessage(
        error instanceof Error ? error.message : "browser transport unavailable"
      );
      return {
        errorResult: makeErrorResult(
          502,
          `Z.ai browser transport failed: ${message}`,
          input.body,
          ZAI_CHAT_URL
        ),
      };
    }

    if (result.status < 200 || result.status >= 300) {
      return {
        errorResult: makeErrorResult(
          result.status || 502,
          describeZaiBrowserFailure(result),
          input.body,
          ZAI_NEW_CHAT_URL
        ),
      };
    }

    // LEV fork: Z.ai's browser POSTs to /api/v1/chats/new which returns
    // JSON with a chat ID, not an SSE stream. Extract the chat ID and make
    // a direct fetch to /api/chat/completions for the actual stream.
    const responseBody = result.body.toString("utf8");
    const contentType = result.contentType || "";

    // Check if this is a JSON response (chats/new) vs SSE (chat/completions)
    if (contentType.includes("application/json") || responseBody.trim().startsWith("{")) {
      try {
        const chatData = JSON.parse(responseBody);
        const chatId = typeof chatData?.id === "string" ? chatData.id : "";
        if (!chatId) {
          return {
            errorResult: makeErrorResult(
              502,
              "Z.ai browser transport: chats/new returned no chat id",
              input.body,
              ZAI_NEW_CHAT_URL
            ),
          };
        }

        // Now fetch the SSE stream directly using the chat ID and token
        const timestamp = Date.now();
        const requestId = randomUUID();
        const userId = ""; // Browser transport doesn't have userId; the token is enough
        const completionUrl = buildZaiCompletionUrl({
          requestId,
          timestamp,
          token: input.token,
          userId,
          clientVersion,
        });
        const reqHeaders = buildZaiHeaders(input.token, {
          accept: "text/event-stream",
          frontendVersion,
          clientVersion,
        });
        const reqBody = buildZaiRequestBody({
          body: (input.body || {}) as Record<string, unknown>,
          captchaVerifyParam: "",
          chatId,
          clientVersion,
          messages: input.messages,
          modelId: input.modelId,
          prompt: browserPrompt(input.messages),
          userMessageId: randomUUID(),
          enableThinking: input.thinkingConfig.enabled,
          reasoningEffort: input.thinkingConfig.effort,
          reasoningEffortSupported: input.thinkingConfig.effortSupported,
          vlmConfig: input.vlmConfig,
        });

        const streamResponse = await fetch(completionUrl, {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify(reqBody),
          signal: input.signal,
        });

        if (!streamResponse.ok) {
          const errorText = await streamResponse.text().catch(() => "");
          return {
            errorResult: makeErrorResult(
              streamResponse.status,
              `Z.ai completion stream failed: ${sanitizeErrorMessage(errorText)}`,
              input.body,
              completionUrl
            ),
          };
        }

        return {
          upstream: streamResponse,
          auditHeaders: {
            Authorization: "Bearer [REDACTED]",
            "X-OmniRoute-Transport": "browser+direct",
          },
          auditBody: buildZaiBrowserAuditBody({
            messages: input.messages,
            modelId: input.modelId,
            thinkingConfig: input.thinkingConfig,
            vlmConfig: input.vlmConfig,
            imageCount: attachments.length,
          }),
        };
      } catch (parseError) {
        return {
          errorResult: makeErrorResult(
            502,
            `Z.ai browser transport: failed to parse chats/new response: ${sanitizeErrorMessage(parseError instanceof Error ? parseError.message : String(parseError))}`,
            input.body,
            ZAI_NEW_CHAT_URL
          ),
        };
      }
    }

    // Fallback: if the response is SSE (older Z.ai flow), pass it through directly
    return {
      upstream: new Response(new Uint8Array(result.body), {
        status: result.status,
        headers: {
          "Content-Type": result.contentType || "text/event-stream",
        },
      }),
      auditHeaders: {
        Authorization: "Bearer [REDACTED]",
        "X-OmniRoute-Transport": "browser",
      },
      auditBody: buildZaiBrowserAuditBody({
        messages: input.messages,
        modelId: input.modelId,
        thinkingConfig: input.thinkingConfig,
        vlmConfig: input.vlmConfig,
        imageCount: attachments.length,
      }),
    };
  }

  /**
   * Signed-API transport: create a chat server-side, then POST the completion with
   * a CAPTCHA proof and a per-request signature. Only reachable when the caller
   * supplied a proof and sent no images.
   */
  private async fetchViaSignedApi(
    request: ZaiResolvedRequest,
    input: ExecuteInput
  ): Promise<ZaiTransportResult | { errorResult: ReturnType<typeof makeErrorResult> }> {
    const { body, signal } = input;
    const bodyObj = (body || {}) as Record<string, unknown>;
    const { messages, modelId, prompt, thinkingConfig, token, userId, vlmConfig } = request;

    const frontendVersion = await this.resolveFrontendVersion(signal);
    const clientVersion = await this.resolveClientVersion(signal);
    const createdChat = await this.createRemoteChat({
      messages,
      modelId,
      token,
      enableThinking: thinkingConfig.enabled,
      reasoningEffort: thinkingConfig.effort,
      vlmConfig,
      signal,
      originalBody: body,
      frontendVersion,
      clientVersion,
    });
    if ("errorResult" in createdChat) return createdChat;

    const timestamp = Date.now();
    const requestId = randomUUID();
    const signature = buildZaiSignature({ prompt, requestId, timestamp, userId });
    const completionUrl = buildZaiCompletionUrl({
      requestId,
      timestamp,
      token,
      userId,
      clientVersion,
    });
    const reqHeaders = buildZaiHeaders(token, {
      accept: "text/event-stream",
      frontendVersion,
      clientVersion,
      signature,
    });
    const reqBody = buildZaiRequestBody({
      body: bodyObj,
      captchaVerifyParam: request.captchaVerifyParam,
      chatId: createdChat.chatId,
      clientVersion,
      messages,
      modelId,
      prompt,
      userMessageId: createdChat.userMessageId,
      enableThinking: thinkingConfig.enabled,
      reasoningEffort: thinkingConfig.effort,
      reasoningEffortSupported: thinkingConfig.effortSupported,
      vlmConfig,
    });
    const fetched = await this.fetchUpstream(completionUrl, reqHeaders, reqBody, body, signal);
    if ("errorResult" in fetched) return fetched;

    return {
      upstream: fetched.upstream,
      auditHeaders: {
        ...reqHeaders,
        Authorization: "Bearer [REDACTED]",
        "X-Signature": "[REDACTED]",
      },
      auditBody: { ...reqBody, captcha_verify_param: "[REDACTED]" },
    };
  }

  async execute(input: ExecuteInput) {
    const { body, signal, stream: wantStream } = input;

    const resolved = resolveZaiRequest(input);
    if ("errorResult" in resolved) return resolved.errorResult;
    const request = resolved.request;
    const { imageUrls, messages, modelId, thinkingConfig, token, vlmConfig } = request;

    // LEV fork: Pre-dispatch session validation.
    // Refuse to route to a dead session instead of producing a silent 200
    // with content: null (the #1 user-facing bug).
    // The connectionId is derived from the token hash for cache keying.
    const connectionId = `zai-web-${token.slice(0, 12)}`;
    const sessionValid = await this.sessionDriver.validateSession(token, connectionId);
    if (!sessionValid) {
      return makeErrorResult(
        503,
        "Z.ai web session is expired or invalid. Re-authenticate via the dashboard's provider connection settings.",
        body,
        ZAI_CHAT_URL
      );
    }

    const useSignedApi = Boolean(request.captchaVerifyParam) && imageUrls.length === 0;
    const fetched = useSignedApi
      ? await this.fetchViaSignedApi(request, input)
      : await this.fetchThroughBrowser({
          body,
          imageUrls,
          messages,
          modelId,
          signal,
          thinkingConfig,
          token,
          vlmConfig,
        });
    if ("errorResult" in fetched) return fetched.errorResult;
    const { upstream, auditHeaders, auditBody } = fetched;

    const id = `chatcmpl-zai-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const sourceBody =
      upstream.body ?? new ReadableStream({ start: (controller) => controller.close() });
    const emitChunk = makeZaiChunkEmitter(id, created, modelId);
    if (wantStream) {
      let outStream = buildZaiStreamingBody(sourceBody, emitChunk, signal, () =>
        this.invalidateClientVersion()
      );
      // LEV fork: Wrap the stream with a watchdog that detects empty/truncated
      // responses — the exact bug where zai-web returned content: null with
      // completion_tokens: 0 and HTTP 200.
      outStream = this.sessionDriver.withStreamWatchdog(outStream, {
        connectionId,
        onTimeout: () => {
          this.sessionDriver.markExpired(
            connectionId,
            "Stream watchdog: no content received within timeout"
          );
        },
        onEmptyStream: () => {
          this.sessionDriver.markExpired(
            connectionId,
            "Stream completed with no content — session is likely expired"
          );
        },
      });
      return {
        response: new Response(outStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
        url: ZAI_CHAT_URL,
        headers: auditHeaders,
        transformedBody: auditBody,
      };
    }

    let answer: string;
    let reasoning: string;
    try {
      ({ answer, reasoning } = await collectZaiNonStreaming(sourceBody));
    } catch (error) {
      const message = sanitizeErrorMessage(
        error instanceof Error ? error.message : "invalid upstream stream"
      );
      return makeErrorResult(502, `Z.ai stream failed: ${message}`, body, ZAI_CHAT_URL);
    }

    // LEV fork: Detect Z.ai's "client version outdated" error, which is
    // returned as completion text in a 200 response. When detected, invalidate
    // the cached version and surface a proper error instead of passing the
    // error message to the IDE as if it were a valid assistant response.
    if (isZaiVersionOutdatedError(answer)) {
      this.invalidateClientVersion();
      return makeErrorResult(
        426,
        "Z.ai rejected the request: client version is outdated. The version cache has been invalidated — retry with a refreshed version.",
        body,
        ZAI_CHAT_URL
      );
    }

    // LEV fork: Empty-content detection for non-streaming responses.
    // If the upstream returned an empty answer, the session is likely expired.
    if (!answer && !reasoning) {
      this.sessionDriver.markExpired(
        connectionId,
        "Non-streaming response had empty content and reasoning — session is likely expired"
      );
      return makeErrorResult(
        503,
        "Z.ai web session returned an empty response — the session is likely expired. Re-authenticate via the dashboard.",
        body,
        ZAI_CHAT_URL
      );
    }

    // LEV fork: Mark the session as healthy after a successful completion.
    this.sessionDriver.markHealthy(connectionId);

    const message: Record<string, unknown> = { role: "assistant", content: answer };
    if (reasoning) message.reasoning_content = reasoning;
    const completion = {
      id,
      object: "chat.completion",
      created,
      model: modelId,
      choices: [{ index: 0, message, finish_reason: "stop" }],
    };
    return {
      response: new Response(JSON.stringify(completion), {
        headers: { "Content-Type": "application/json" },
      }),
      url: ZAI_CHAT_URL,
      headers: auditHeaders,
      transformedBody: auditBody,
    };
  }
}
