// LEV fork: eventsource-parser-based SSE parsing utilities.
//
// Replaces manual SSE frame scanning with the battle-tested eventsource-parser
// library (used by Vercel AI SDK). Handles partial frames, multi-line data,
// comments, and reconnection — eliminating the 64KB buffer truncation risk
// in the manual streamReadiness.ts implementation.
//
// This module provides:
//   - parseSseEvents(): async generator that yields parsed SSE events
//   - isUsefulSseEvent(): checks if an event has useful content (not just pings)
//   - createSseReader(): creates a reader that peeks at the first useful event

import { createParser, type EventSourceMessage } from "eventsource-parser";

/**
 * Check if an SSE message is a ping/keepalive (no useful content).
 */
export function isUsefulSseEvent(message: EventSourceMessage): boolean {
  // Empty data or just whitespace → ping
  if (!message.data || message.data.trim() === "") return false;
  // OpenAI/DoneAI ping events
  if (message.event === "ping") return false;
  // Anthropic ping events
  if (message.data === ": ping" || message.data === "ping") return false;
  // OpenAI done marker
  if (message.data === "[DONE]") return false;
  return true;
}

/**
 * Parse SSE events from a ReadableStream<Uint8Array>.
 * Yields parsed EventSourceMessage objects.
 *
 * Usage:
 *   for await (const event of parseSseEvents(response.body)) {
 *     if (isUsefulSseEvent(event)) {
 *       // process event.data
 *     }
 *   }
 */
export async function* parseSseEvents(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<EventSourceMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = createParser({
    onEvent: (message: EventSourceMessage) => {
      // Push to a queue for the async generator
      queue.push(message);
    },
  });

  const queue: EventSourceMessage[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      parser.feed(text);

      // Yield any events that were parsed
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    }
    // Flush any remaining events
    while (queue.length > 0) {
      yield queue.shift()!;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Peek at the first useful SSE event in a stream.
 * Returns the event and a rebuilt stream that includes all buffered chunks
 * (so the caller can still consume the full stream).
 *
 * Returns null if no useful event is found within the byte/time budget.
 */
export async function peekFirstUsefulEvent(
  stream: ReadableStream<Uint8Array>,
  options: {
    maxBytes?: number;
    timeoutMs?: number;
  } = {}
): Promise<{
  firstEvent: EventSourceMessage | null;
  rebuiltStream: ReadableStream<Uint8Array>;
}> {
  const { maxBytes = 65536, timeoutMs = 30000 } = options;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const bufferedChunks: Uint8Array[] = [];
  let totalBytes = 0;
  let firstEvent: EventSourceMessage | null = null;
  const startTime = Date.now();

  const parser = createParser({
    onEvent: (message: EventSourceMessage) => {
      if (!firstEvent && isUsefulSseEvent(message)) {
        firstEvent = message;
      }
    },
  });

  try {
    while (!firstEvent) {
      if (Date.now() - startTime > timeoutMs) break;
      if (totalBytes > maxBytes) break;

      const readPromise = reader.read();
      const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs)
      );
      const result = await Promise.race([readPromise, timeoutPromise]);

      if (!result || result.done || !result.value) break;

      bufferedChunks.push(result.value);
      totalBytes += result.value.byteLength;
      const text = decoder.decode(result.value, { stream: true });
      parser.feed(text);
    }
  } finally {
    reader.releaseLock();
  }

  // Rebuild the stream: buffered chunks + original stream
  const rebuiltStream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Enqueue buffered chunks
      for (const chunk of bufferedChunks) {
        controller.enqueue(chunk);
      }
      // Pipe the rest of the original stream
      (async () => {
        const reader2 = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader2.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          reader2.releaseLock();
        }
      })();
    },
  });

  return { firstEvent, rebuiltStream };
}
