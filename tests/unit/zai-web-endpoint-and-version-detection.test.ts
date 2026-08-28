// LEV fork: Z.ai-web endpoint and version error detection tests.
// Verifies that:
// 1. The completions endpoint uses /api/chat/completions (not deprecated /api/v2)
// 2. The version outdated error is detected in streaming and non-streaming paths
// 3. The version outdated regex matches Z.ai's actual error format
//
// Run: node --import tsx/esm --test tests/unit/zai-web-endpoint-and-version-detection.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-zai-endpoint-"));

const { ZAI_CHAT_URL, ZAI_BASE_URL, ZAI_DEFAULT_CLIENT_VERSION, ZAI_DEFAULT_FE_VERSION } =
  await import("../../open-sse/executors/zai-web/protocol.ts");

const { isZaiVersionOutdatedError, ZAI_VERSION_OUTDATED_RE } =
  await import("../../open-sse/executors/zai-web/stream.ts");

// ── Endpoint URL ───────────────────────────────────────────────────────────

test("ZAI_CHAT_URL uses /api/chat/completions (not deprecated /api/v2)", () => {
  assert.equal(
    ZAI_CHAT_URL,
    `${ZAI_BASE_URL}/api/chat/completions`,
    "Endpoint must be /api/chat/completions — the v2 endpoint is deprecated and ignores version params"
  );
  assert.ok(
    !ZAI_CHAT_URL.includes("/api/v2/"),
    "Must NOT contain /api/v2/ — that endpoint silently drops the client version"
  );
});

test("ZAI_BASE_URL is chat.z.ai", () => {
  assert.equal(ZAI_BASE_URL, "https://chat.z.ai");
});

// ── Default versions ───────────────────────────────────────────────────────

test("ZAI_DEFAULT_CLIENT_VERSION is 1.0.91", () => {
  assert.equal(ZAI_DEFAULT_CLIENT_VERSION, "1.0.91");
});

test("ZAI_DEFAULT_FE_VERSION matches current Z.ai frontend", () => {
  // The FE version should match the prod-fe-X.Y.Z pattern in Z.ai's homepage
  assert.match(ZAI_DEFAULT_FE_VERSION, /^prod-fe-\d+\.\d+\.\d+$/);
});

// ── Version outdated regex ─────────────────────────────────────────────────

test("ZAI_VERSION_OUTDATED_RE matches Z.ai's actual error format", () => {
  // The exact error text from Z.ai:
  const errorText =
    "Your client version (unknown) is outdated. Minimum required: 1.0.91. Please refresh the page";
  assert.ok(ZAI_VERSION_OUTDATED_RE.test(errorText), "should match the actual error");
});

test("ZAI_VERSION_OUTDATED_RE matches with different version in parentheses", () => {
  assert.ok(ZAI_VERSION_OUTDATED_RE.test("Your client version (1.0.90) is outdated"));
  assert.ok(ZAI_VERSION_OUTDATED_RE.test("client version (0.9.0) is outdated."));
});

test("ZAI_VERSION_OUTDATED_RE does not match normal text", () => {
  assert.ok(!ZAI_VERSION_OUTDATED_RE.test("Here is your code response"));
  assert.ok(!ZAI_VERSION_OUTDATED_RE.test("The client requested a new feature"));
  assert.ok(!ZAI_VERSION_OUTDATED_RE.test("version 1.0.91 is now available"));
});

// ── isZaiVersionOutdatedError function ─────────────────────────────────────

test("isZaiVersionOutdatedError detects the error in full text", () => {
  const fullError =
    "Your client version (unknown) is outdated. Minimum required: 1.0.91. Please refresh the page";
  assert.ok(isZaiVersionOutdatedError(fullError));
});

test("isZaiVersionOutdatedError returns false for normal content", () => {
  assert.ok(!isZaiVersionOutdatedError("Here is the implementation you requested."));
  assert.ok(!isZaiVersionOutdatedError(""));
  assert.ok(!isZaiVersionOutdatedError("The function works correctly."));
});

test("isZaiVersionOutdatedError detects error embedded in longer text", () => {
  // Z.ai sometimes prepends whitespace or other content
  const embedded = "\n\nYour client version (unknown) is outdated. Minimum required: 1.0.91.";
  assert.ok(isZaiVersionOutdatedError(embedded));
});

// ── Streaming version error detection ──────────────────────────────────────

test("buildZaiStreamingBody calls onVersionOutdated when error is in stream", async () => {
  const { buildZaiStreamingBody, makeZaiChunkEmitter } =
    await import("../../open-sse/executors/zai-web/stream.ts");

  // Simulate a Z.ai SSE stream that returns the version error as content
  const errorSse = [
    'data: {"choices":[{"delta":{"content":"Your client version (unknown) is outdated. Minimum required: 1.0.91. Please refresh the page"}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");

  const sourceBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(errorSse));
      controller.close();
    },
  });

  let versionOutdatedCalled = false;
  const emitChunk = makeZaiChunkEmitter("test-id", Date.now(), "test-model");
  const stream = buildZaiStreamingBody(sourceBody, emitChunk, null, () => {
    versionOutdatedCalled = true;
  });

  // Drain the stream
  const reader = stream.getReader();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }

  assert.ok(versionOutdatedCalled, "onVersionOutdated should have been called");
  const allContent = chunks.join("");
  assert.ok(
    allContent.includes("[Z.ai error] Client version is outdated"),
    "Stream should contain the error message, not the raw Z.ai error text"
  );
  assert.ok(
    !allContent.includes("Your client version (unknown) is outdated"),
    "Raw Z.ai error text should NOT be passed through as content"
  );
});

test("buildZaiStreamingBody does not call onVersionOutdated for normal content", async () => {
  const { buildZaiStreamingBody, makeZaiChunkEmitter } =
    await import("../../open-sse/executors/zai-web/stream.ts");

  const normalSse = [
    'data: {"choices":[{"delta":{"content":"Here is your code: function hello() { return \\"hello\\"; }"}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");

  const sourceBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(normalSse));
      controller.close();
    },
  });

  let versionOutdatedCalled = false;
  const emitChunk = makeZaiChunkEmitter("test-id", Date.now(), "test-model");
  const stream = buildZaiStreamingBody(sourceBody, emitChunk, null, () => {
    versionOutdatedCalled = true;
  });

  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }

  assert.ok(!versionOutdatedCalled, "onVersionOutdated should NOT be called for normal content");
});
