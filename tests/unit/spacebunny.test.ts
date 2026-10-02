import { test } from "node:test";
import assert from "node:assert/strict";
import { translateBuffered, translateStream } from "../../open-sse/executors/spacebunny.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function sseResponse(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const DONE_DATA = {
  message: { role: "assistant", content: "Hello world" },
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello world" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  creditsUsed: 2,
  model: "stealth/space-bunny-alpha",
  elapsedMs: 1200,
};

test("translateBuffered: done event becomes a chat.completion JSON", async () => {
  const upstream = sseResponse([
    { type: "delta", content: "Hello " },
    { type: "delta", content: "world" },
    { type: "done", data: DONE_DATA },
  ]);
  const res = await translateBuffered(upstream, "space-bunny");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "stealth/space-bunny-alpha");
  assert.equal(body.choices[0].message.content, "Hello world");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.usage.total_tokens, 12);
  assert.ok(body.id);
  assert.ok(body.created > 0);
});

test("translateBuffered: deltas without done still produce a completion", async () => {
  const upstream = sseResponse([
    { type: "delta", content: "partial " },
    { type: "delta", content: "answer" },
  ]);
  const res = await translateBuffered(upstream, "space-bunny");
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "partial answer");
  assert.equal(body.model, "space-bunny");
});

test("translateStream: emits OpenAI chunks, finish frame, usage, [DONE]", async () => {
  const upstreamText =
    `data: ${JSON.stringify({ type: "delta", content: "Hel" })}\n\n` +
    `data: ${JSON.stringify({ type: "delta", content: "lo" })}\n\n` +
    `data: ${JSON.stringify({ type: "done", data: DONE_DATA })}\n\n`;

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      // split across chunk boundaries to exercise buffering
      const bytes = enc.encode(upstreamText);
      controller.enqueue(bytes.slice(0, 40));
      controller.enqueue(bytes.slice(40, 90));
      controller.enqueue(bytes.slice(90));
      controller.close();
    },
  });

  const out = translateStream(source, "space-bunny");
  const reader = out.getReader();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }

  const frames = text
    .split("\n\n")
    .filter((f) => f.startsWith("data:"))
    .map((f) => f.slice(5).trim());

  assert.equal(frames[frames.length - 1], "[DONE]");

  const jsonFrames = frames.slice(0, -1).map((f) => JSON.parse(f));
  const deltas = jsonFrames.filter((f) => f.choices?.[0]?.delta?.content !== undefined);
  assert.equal(deltas.map((d) => d.choices[0].delta.content).join(""), "Hello");
  assert.equal(deltas[0].choices[0].delta.role, "assistant");
  assert.equal(deltas[0].object, "chat.completion.chunk");

  const finish = jsonFrames.find((f) => f.choices?.[0]?.finish_reason === "stop");
  assert.ok(finish, "expected a finish chunk");

  const usage = jsonFrames.find((f) => f.usage);
  assert.ok(usage, "expected a usage chunk");
  assert.equal(usage.choices.length, 0);
  assert.equal(usage.usage.total_tokens, 12);
});

test("translateStream: upstream error event becomes an OpenAI error frame", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        enc.encode(`data: ${JSON.stringify({ type: "error", message: "boom" })}\n\n`)
      );
      controller.close();
    },
  });
  const out = translateStream(source, "space-bunny");
  const reader = out.getReader();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  assert.match(text, /"error"/);
  assert.match(text, /boom/);
  assert.match(text, /data: \[DONE\]/);
});
