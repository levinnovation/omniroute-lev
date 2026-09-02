// LEV fork: eventsource-parser-based SSE parsing service.
//
// Wraps @eventsource-parser/parser to provide a structured, streaming-friendly
// SSE parser that handles partial frames across chunk boundaries, multi-line
// data fields, comments, and the [DONE] sentinel. This is a higher-level
// service utility built on top of open-sse/utils/sseParser.ts — it adds
// structured event emission, [DONE] handling, and a ReadableStream transform
// so new code can adopt it gradually without touching the existing manual
// parsing hot path.
//
// Exports:
//   - SseEvent: structured { event, data, id }
//   - parseSseStream(): async generator yielding SseEvent from a ReadableStream
//   - createSseTransformStream(): TransformStream<Uint8Array, SseEvent>
//   - isDoneSentinel(): detects the OpenAI [DONE] marker

import { createParser, type EventSourceMessage } from "eventsource-parser";

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export const DONE_SENTINEL = "[DONE]";

export function isDoneSentinel(data: string): boolean {
  return data.trim() === DONE_SENTINEL;
}

function toSseEvent(message: EventSourceMessage): SseEvent {
  return { event: message.event, data: message.data, id: message.id };
}

/**
 * Parse SSE events from a ReadableStream<Uint8Array>.
 * Yields structured SseEvent objects, handling partial frames across chunk
 * boundaries automatically (eventsource-parser buffers internally).
 *
 * The [DONE] sentinel is emitted as a normal SseEvent whose data is "[DONE]";
 * callers can use isDoneSentinel() to detect it.
 *
 * Usage:
 *   for await (const event of parseSseStream(response.body)) {
 *     if (isDoneSentinel(event.data)) break;
 *     // process event.data
 *   }
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  options: { maxBufferSize?: number } = {}
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const queue: SseEvent[] = [];

  const parser = createParser({
    maxBufferSize: options.maxBufferSize,
    onEvent: (message: EventSourceMessage) => {
      queue.push(toSseEvent(message));
    },
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      parser.feed(text);
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    }
    parser.reset({ consume: true });
    while (queue.length > 0) {
      yield queue.shift()!;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Create a TransformStream that converts raw SSE bytes into structured
 * SseEvent objects. Useful for piping a fetch Response body through a
 * stream pipeline.
 *
 * Usage:
 *   const transform = createSseTransformStream();
 *   response.body.pipeThrough(transform);
 *   for await (const event of transform.readable) { ... }
 */
export function createSseTransformStream(
  options: { maxBufferSize?: number } = {}
): TransformStream<Uint8Array, SseEvent> {
  const decoder = new TextDecoder();
  const parser = createParser({
    maxBufferSize: options.maxBufferSize,
    onEvent: (message: EventSourceMessage) => {
      controller.enqueue(toSseEvent(message));
    },
  });
  let controller: TransformStreamDefaultController<SseEvent>;

  return new TransformStream<Uint8Array, SseEvent>({
    start(c) {
      controller = c;
    },
    transform(chunk) {
      const text = decoder.decode(chunk, { stream: true });
      parser.feed(text);
    },
    flush() {
      parser.reset({ consume: true });
    },
  });
}

/**
 * Collect all SSE events from a stream into an array.
 * Mainly useful for tests and non-streaming consumers.
 */
export async function collectSseEvents(
  stream: ReadableStream<Uint8Array>,
  options: { maxBufferSize?: number } = {}
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(stream, options)) {
    events.push(event);
  }
  return events;
}
