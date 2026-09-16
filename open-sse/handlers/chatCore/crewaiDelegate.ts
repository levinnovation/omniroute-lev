/**
 * LEV fork Phase 4: CrewAI agentic coding delegate.
 *
 * When OMNIROUTE_CREWAI_URL is set and the request model has the "agentic/"
 * prefix (e.g. "agentic/coder"), OmniRoute delegates the request to the
 * CrewAI coding sidecar. The sidecar runs a CrewAI flow that uses OmniRoute
 * as its LLM backend (via the internal API key), executes coding tools
 * (file ops, shell, web search), and returns the result.
 *
 * Recursion prevention:
 * - The CrewAI sidecar calls back to OmniRoute with OMNIROUTE_INTERNAL_AGENT_KEY.
 * - OmniRoute detects this key and NEVER routes internal requests to the
 *   CrewAI sidecar.
 * - A depth header (X-OmniRoute-Depth) tracks delegation depth; max depth = 2.
 * - A request ID header (X-OmniRoute-Request-Id) enables end-to-end tracing.
 *
 * If the CrewAI sidecar is unreachable or returns an error, the delegate
 * returns null so the existing OmniRoute executor path handles the request.
 */

import { getCrewAIConfig } from "../../services/sidecars.ts";
import { randomUUID } from "node:crypto";

export interface CrewAIDelegateArgs {
  model: string;
  body: Record<string, unknown> | null | undefined;
  stream: boolean;
  signal?: AbortSignal | null;
  log?: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | null;
  /** The API key from the incoming request. Used to detect internal requests. */
  requestApiKey?: string | null;
  /** Incoming request ID for tracing (from x-request-id header). */
  requestId?: string | null;
  /** Incoming depth header value for recursion tracking. */
  depth?: number | null;
  /** Whether to allow silent fallback to direct model when CrewAI fails. */
  allowDirectFallback?: boolean;
}

export interface CrewAIDelegateResult {
  success: boolean;
  response: Response;
}

/** Maximum delegation depth (prevents infinite recursion). */
const MAX_DELEGATION_DEPTH = 2;

/** Model prefix that triggers CrewAI delegation. */
const AGENTIC_PREFIX = "agentic/";

/** Header name for tracking delegation depth. */
const DEPTH_HEADER = "x-omniroute-depth";

/** Header name for request tracing. */
const REQUEST_ID_HEADER = "x-omniroute-request-id";

/**
 * Check if the request should be delegated to the CrewAI sidecar.
 * Returns false when:
 * - The CrewAI sidecar is not configured.
 * - The request is from an internal agent (recursion prevention).
 * - The model does not have the "agentic/" prefix.
 * - The delegation depth exceeds the maximum.
 */
export function shouldDelegateToCrewAI(args: CrewAIDelegateArgs): boolean {
  // Sidecar must be configured
  if (!process.env.OMNIROUTE_CREWAI_URL) return false;

  // Recursion prevention: detect internal API key
  const internalKey = process.env.OMNIROUTE_INTERNAL_AGENT_KEY;
  if (internalKey && args.requestApiKey === internalKey) {
    return false; // Internal request — never route back to CrewAI
  }

  // Model must have the agentic/ prefix
  if (!args.model.startsWith(AGENTIC_PREFIX)) return false;

  // Depth check: if the incoming request already has a depth header that
  // exceeds the maximum, do not delegate further.
  if (args.depth !== null && args.depth !== undefined && args.depth >= MAX_DELEGATION_DEPTH) {
    return false;
  }

  return true;
}

/**
 * Extract the underlying LLM model from an "agentic/" prefixed model.
 * "agentic/coder" → "coder" (the CrewAI sidecar resolves the actual model).
 * "agentic/gpt-4o" → "gpt-4o" (explicit model passthrough).
 */
export function extractAgenticModel(model: string): string {
  return model.startsWith(AGENTIC_PREFIX) ? model.slice(AGENTIC_PREFIX.length) : model;
}

/**
 * Attempt to delegate an agentic coding request to the CrewAI sidecar.
 * Returns null when delegation is not applicable or fails — the caller
 * falls back to the existing OmniRoute executor path.
 *
 * The CrewAI sidecar runs a CrewAI flow that:
 * 1. Receives the coding prompt.
 * 2. Uses OmniRoute as its LLM backend (via OMNIROUTE_INTERNAL_AGENT_KEY).
 * 3. Executes coding tools (file_read, file_write, shell_exec, web_search).
 * 4. Returns the coding result.
 *
 * OmniRoute wraps the result as an OpenAI-compatible chat completion response.
 */
export async function tryCrewAIDelegate(
  args: CrewAIDelegateArgs
): Promise<CrewAIDelegateResult | null> {
  if (!shouldDelegateToCrewAI(args)) return null;
  if (!args.body || typeof args.body !== "object") return null;

  const config = getCrewAIConfig();
  if (!config) return null;

  // Extract the coding prompt from the chat messages
  const messages = args.body.messages as Array<{ role: string; content: string }> | undefined;
  if (!messages || messages.length === 0) return null;

  // Extract the last user message as the coding prompt
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;

  const prompt =
    typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
  const agenticModel = extractAgenticModel(args.model);

  // Generate or forward a request ID for tracing
  const requestId = args.requestId ?? `omniroute-${randomUUID()}`;
  const traceId = `trace-${randomUUID()}`;
  const currentDepth = (args.depth ?? 0) + 1;

  // Extract workspace and client info from request metadata if present
  const metadata = (args.body.metadata as Record<string, unknown> | undefined) ?? {};
  const workspace = metadata.workspace as Record<string, unknown> | undefined;
  const client = metadata.client as Record<string, unknown> | undefined;

  // Build the CrewAI sidecar request with full conversation context
  const crewaiBody = {
    requestId,
    model: agenticModel,
    inputs: {
      message: prompt,
      model: agenticModel,
      // Pass through full conversation context for multi-turn
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
      ...(workspace ? { workspace } : {}),
      ...(client ? { client } : {}),
    },
    stream: false, // v0.1: non-streaming
    metadata: {
      traceId,
      parentRequestId: args.requestId ?? undefined,
      recursionDepth: currentDepth,
    },
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [DEPTH_HEADER]: String(currentDepth),
    [REQUEST_ID_HEADER]: requestId,
  };
  if (config.apiKey) {
    headers["X-API-Key"] = config.apiKey;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 120_000);
    const signal = args.signal ?? controller.signal;

    args.log?.debug?.(
      "CREWAI",
      `delegating agentic request to CrewAI sidecar (model=${agenticModel}, requestId=${requestId}, depth=${currentDepth}, stream=${args.stream})`
    );

    // v0.2: When streaming is requested, use the streaming endpoint.
    // The sidecar emits SidecarStreamEvent SSE events which we relay to the client.
    const endpoint = args.stream
      ? `${config.url.replace(/\/$/, "")}/api/v1/run/stream`
      : `${config.url.replace(/\/$/, "")}/api/v1/run`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(crewaiBody),
      signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unknown error");
      args.log?.warn?.("CREWAI", `CrewAI sidecar returned ${response.status}: ${errorBody}`);

      // Safe fallback policy: do NOT silently fall back to a direct model.
      // The user may expect remote tooling, a specific coding flow, or
      // distinct policy behavior. Return an explicit AGENTIC_UNAVAILABLE error
      // unless the caller explicitly allows direct fallback.
      if (!args.allowDirectFallback) {
        return {
          success: false,
          response: buildAgenticUnavailableResponse(
            requestId,
            args.model,
            `CrewAI sidecar returned HTTP ${response.status}`,
            true // retryable
          ),
        };
      }

      return null; // Caller explicitly allowed direct fallback
    }

    // v0.2: Streaming response — relay SSE events from the sidecar
    if (args.stream && response.body) {
      return {
        success: true,
        response: relaySidecarStream(response, requestId, args.model, args.log),
      };
    }

    // Non-streaming response — parse JSON and wrap as OpenAI-compatible
    const crewaiResult = await response.json();
    const codingResult = crewaiResult.result || "";
    const error = crewaiResult.error;

    if (error) {
      args.log?.warn?.("CREWAI", `CrewAI flow error: ${JSON.stringify(error)}`);

      // Safe fallback policy: return explicit error unless fallback allowed.
      if (!args.allowDirectFallback) {
        return {
          success: false,
          response: buildAgenticUnavailableResponse(
            requestId,
            args.model,
            `CrewAI flow error: ${error.message ?? JSON.stringify(error)}`,
            error.retryable ?? true
          ),
        };
      }

      return null; // Caller explicitly allowed direct fallback
    }

    // Build an OpenAI-compatible chat completion response
    const completionBody = {
      id: `chatcmpl-crewai-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: args.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: codingResult,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    return {
      success: true,
      response: new Response(JSON.stringify(completionBody), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          [REQUEST_ID_HEADER]: requestId,
        },
      }),
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    args.log?.warn?.("CREWAI", `CrewAI delegation failed: ${errorMessage}`);

    // Safe fallback policy: return explicit error unless fallback allowed.
    if (!args.allowDirectFallback) {
      return {
        success: false,
        response: buildAgenticUnavailableResponse(
          requestId,
          args.model,
          `CrewAI delegation failed: ${errorMessage}`,
          true // Network errors are retryable
        ),
      };
    }

    return null; // Caller explicitly allowed direct fallback
  }
}

/**
 * Check if a request is from an internal agent (recursion prevention).
 * Called from chatCore to skip CrewAI delegation for internal requests.
 */
export function isInternalAgentRequest(apiKey?: string | null): boolean {
  const internalKey = process.env.OMNIROUTE_INTERNAL_AGENT_KEY;
  return !!(internalKey && apiKey === internalKey);
}

/**
 * Extract the delegation depth from request headers.
 */
export function getDelegationDepth(headers: Record<string, string>): number {
  const raw = headers[DEPTH_HEADER] ?? headers[DEPTH_HEADER.toLowerCase()];
  if (!raw) return 0;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Extract the request ID from request headers.
 */
export function getRequestId(headers: Record<string, string>): string | null {
  return headers[REQUEST_ID_HEADER] ?? headers["x-request-id"] ?? null;
}

/**
 * Build an OpenAI-compatible error response for agentic routing failures.
 * Returns HTTP 503 with an actionable error message that does NOT silently
 * fall back to a direct model.
 */
function buildAgenticUnavailableResponse(
  requestId: string,
  model: string,
  cause: string,
  retryable: boolean
): Response {
  const body = {
    id: `chatcmpl-crewai-error-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
        },
        finish_reason: "error",
      },
    ],
    error: {
      type: "agentic_unavailable",
      code: "AGENTIC_UNAVAILABLE",
      message: `Agentic routing unavailable: ${cause}`,
      cause,
      retryable,
      model,
      requestId,
      remediation: `Use a direct model (e.g. omniroute/claude/claude-sonnet-4) or retry later.`,
    },
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  return new Response(JSON.stringify(body), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      [REQUEST_ID_HEADER]: requestId,
    },
  });
}

/**
 * Relay SSE events from the CrewAI sidecar to the client.
 * Maps SidecarStreamEvent events to OpenAI-compatible chat.completion.chunk events.
 *
 * The sidecar emits:
 * - flow.started, agent.started — lifecycle events (mapped to role chunk)
 * - tool.started, tool.completed — tool events (logged, not mapped to client)
 * - content.delta — incremental text (mapped to delta chunk)
 * - completed — final result (mapped to finish chunk)
 * - error — failure (mapped to error chunk)
 */
function relaySidecarStream(
  sidecarResponse: Response,
  requestId: string,
  model: string,
  log?: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | null
): Response {
  const reader = sidecarResponse.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      let sentRole = false;

      const sendChunk = (data: Record<string, unknown>) => {
        const line = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(line));
      };

      const sendDone = () => {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };

      const sendError = (message: string) => {
        sendChunk({
          id: `chatcmpl-crewai-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: { content: `\n\nError: ${message}` },
              finish_reason: "error",
            },
          ],
        });
        sendDone();
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") {
              sendDone();
              return;
            }

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }

            const eventType = event.type as string;

            // Send initial role chunk on first event
            if (!sentRole) {
              sendChunk({
                id: `chatcmpl-crewai-${requestId}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant" },
                    finish_reason: null,
                  },
                ],
              });
              sentRole = true;
            }

            switch (eventType) {
              case "content.delta":
                sendChunk({
                  id: `chatcmpl-crewai-${requestId}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: event.delta as string },
                      finish_reason: null,
                    },
                  ],
                });
                break;

              case "tool.started":
                log?.debug?.("CREWAI", `tool.started: ${event.tool}`);
                // Optionally emit a progress chunk to the client
                sendChunk({
                  id: `chatcmpl-crewai-${requestId}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: `\n\n[tool: ${event.tool}]` },
                      finish_reason: null,
                    },
                  ],
                });
                break;

              case "tool.completed":
                log?.debug?.("CREWAI", `tool.completed: ${event.tool}`);
                break;

              case "completed":
                sendChunk({
                  id: `chatcmpl-crewai-${requestId}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: (event.finishReason as string) ?? "stop",
                    },
                  ],
                });
                sendDone();
                return;

              case "error":
                sendError((event.message as string) ?? "Unknown error");
                return;

              case "flow.started":
              case "agent.started":
                // Lifecycle events — log but don't emit to client
                log?.debug?.("CREWAI", `${eventType}: ${event.message ?? ""}`);
                break;

              default:
                // Unknown event type — log and continue
                log?.debug?.("CREWAI", `unknown event: ${eventType}`);
                break;
            }
          }
        }

        // Stream ended without [DONE] or completed — send done anyway
        sendDone();
      } catch (err) {
        sendError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      [REQUEST_ID_HEADER]: requestId,
    },
  });
}
