import { DefaultExecutor } from "./default.ts";
import type { ExecuteInput, ExecutorExecuteResult } from "./base.ts";

/**
 * Space Bunny (https://spacebunny.app) — anonymous-preview OpenAI-shaped chat
 * provider. The request side is standard chat completions; the response side is
 * NOT: the upstream proxy always replies with a custom SSE dialect regardless
 * of the `stream` flag:
 *
 *   data: {"type":"delta","content":"..."}
 *   data: {"type":"done","data":{"message":{...},"choices":[...],"usage":{...},"model":"stealth/space-bunny-alpha",...}}
 *
 * Errors are plain JSON `{"code":..,"message":".."}` with a non-2xx status.
 *
 * This executor translates that dialect back into real OpenAI wire format so
 * OpenAI-compatible clients (opencode, AI SDK) work unchanged:
 *   - stream clients   → chat.completion.chunk frames + a trailing usage chunk + [DONE]
 *   - non-stream clients → buffered chat.completion JSON built from the `done` event
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type SsePayload = Record<string, unknown> | null;

function eventData(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  if (lines.length === 0) return null;
  return lines.map((l) => l.slice(5).replace(/^ /, "")).join("\n");
}

function parsePayload(payload: string): SsePayload {
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function newChunkId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function toOpenAiJson(
  done: Record<string, unknown> | null,
  fallbackContent: string,
  model: string
) {
  const doneChoices = Array.isArray(done?.choices) ? (done!.choices as unknown[]) : null;
  const doneMessage =
    done && typeof done.message === "object" && done.message !== null
      ? (done.message as Record<string, unknown>)
      : (doneChoices?.[0] as Record<string, unknown> | undefined)?.message;
  const message =
    doneMessage && typeof doneMessage === "object"
      ? doneMessage
      : { role: "assistant", content: fallbackContent };
  return {
    id: typeof done?.id === "string" ? done.id : newChunkId(),
    object: "chat.completion",
    created: typeof done?.created === "number" ? done.created : Math.floor(Date.now() / 1000),
    model: typeof done?.model === "string" ? done.model : model,
    choices:
      doneChoices && doneChoices.length > 0
        ? doneChoices
        : [{ index: 0, message, finish_reason: "stop" }],
    usage: done?.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export async function translateBuffered(response: Response, model: string): Promise<Response> {
  const text = await response.text();
  let done: Record<string, unknown> | null = null;
  let content = "";
  for (const rawEvent of text.split(/\r?\n\r?\n/)) {
    const payload = eventData(rawEvent);
    if (!payload || payload === "[DONE]") continue;
    const evt = parsePayload(payload);
    if (!evt) continue;
    if (evt.type === "delta" && typeof evt.content === "string") content += evt.content;
    if (evt.type === "done" && evt.data && typeof evt.data === "object")
      done = evt.data as Record<string, unknown>;
  }
  return new Response(JSON.stringify(toOpenAiJson(done, content, model)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function translateStream(
  upstream: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const id = newChunkId();
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let sentRole = false;
  let finished = false;

  const frame = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
  const chunkBase = () => ({ id, object: "chat.completion.chunk", created, model });

  const emit = (
    evt: Record<string, unknown>,
    controller: TransformStreamDefaultController<Uint8Array>
  ) => {
    if (evt.type === "delta") {
      const delta: Record<string, unknown> = {};
      if (!sentRole) {
        delta.role = "assistant";
        sentRole = true;
      }
      if (typeof evt.content === "string") delta.content = evt.content;
      if (typeof evt.reasoning === "string") delta.reasoning_content = evt.reasoning;
      if (typeof evt.reasoning_content === "string")
        delta.reasoning_content = evt.reasoning_content;
      if (Object.keys(delta).length > 0)
        controller.enqueue(
          frame({ ...chunkBase(), choices: [{ index: 0, delta, finish_reason: null }] })
        );
      return;
    }
    if (evt.type === "done") {
      const data =
        evt.data && typeof evt.data === "object" ? (evt.data as Record<string, unknown>) : {};
      const first = Array.isArray(data.choices)
        ? (data.choices[0] as Record<string, unknown>)
        : null;
      controller.enqueue(
        frame({
          ...chunkBase(),
          choices: [{ index: 0, delta: {}, finish_reason: first?.finish_reason ?? "stop" }],
        })
      );
      if (data.usage && typeof data.usage === "object") {
        controller.enqueue(frame({ ...chunkBase(), choices: [], usage: data.usage }));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      finished = true;
      return;
    }
    if (evt.type === "error") {
      const err =
        evt.error && typeof evt.error === "object" ? (evt.error as Record<string, unknown>) : evt;
      controller.enqueue(
        frame({
          error: {
            message: typeof err.message === "string" ? err.message : "Space Bunny upstream error",
            type: "upstream_error",
          },
        })
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      finished = true;
    }
  };

  const drain = (controller: TransformStreamDefaultController<Uint8Array>) => {
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const payload = eventData(rawEvent);
      if (!payload) continue;
      if (payload === "[DONE]") {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        finished = true;
        continue;
      }
      const evt = parsePayload(payload);
      if (evt) emit(evt, controller);
    }
  };

  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        drain(controller);
      },
      flush(controller) {
        buffer += decoder.decode();
        drain(controller);
        if (!finished) {
          controller.enqueue(
            frame({ ...chunkBase(), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
      },
    })
  );
}

export class SpaceBunnyExecutor extends DefaultExecutor {
  constructor() {
    super("spacebunny");
  }

  transformRequest(model: string, body: unknown, stream: boolean, credentials: unknown): unknown {
    const out = super.transformRequest(model, body, stream, credentials);
    if (!out || typeof out !== "object") return out;
    const b = out as Record<string, unknown>;
    // Space Bunny reasoning control is `reasoning: { effort: low|medium|high|xhigh|max }`.
    const effort = b.reasoning_effort ?? b.reasoningEffort;
    if (effort && !b.reasoning) {
      b.reasoning = { effort: String(effort) };
    }
    delete b.reasoning_effort;
    delete b.reasoningEffort;
    // The upstream proxy always streams its custom SSE dialect; force the flag so
    // nothing downstream mistakes the body for a plain-JSON request/response.
    b.stream = true;
    return out;
  }

  async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    const result = await super.execute(input);
    const response = result instanceof Response ? result : result.response;
    if (!response || !response.ok || !response.body) return result;

    const contentType = response.headers.get("content-type") ?? "";
    const isSse = contentType.includes("text/event-stream") || contentType.includes("stream");
    if (!isSse) return result; // future-proof: pass through if upstream ever ships plain JSON

    const translated = input.stream
      ? new Response(translateStream(response.body, input.model), {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        })
      : await translateBuffered(response, input.model);

    return result instanceof Response ? translated : { ...result, response: translated };
  }
}

export default SpaceBunnyExecutor;
