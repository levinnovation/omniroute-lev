// LEV fork: Pre-gate message truncation for perplexity-web.
// Tests that large Cursor requests (280K+ tokens) are truncated to fit within
// the provider's 40K token context window before the context window gate check.
//
// Run: node --import tsx/esm --test tests/unit/perplexity-web-pre-gate-truncation.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  needsPreGateTruncation,
  truncateMessagesForWebProvider,
} from "../../open-sse/utils/webProviderMessageTruncation.ts";

const CONTEXT_LIMIT = 40_000; // matches perplexity-web defaultContextLength

// ── Provider detection ─────────────────────────────────────────────────────

test("needsPreGateTruncation: perplexity-web is detected", () => {
  assert.equal(needsPreGateTruncation("perplexity-web"), true);
});

test("needsPreGateTruncation: other providers are not detected", () => {
  assert.equal(needsPreGateTruncation("openai"), false);
  assert.equal(needsPreGateTruncation("anthropic"), false);
  assert.equal(needsPreGateTruncation("gemini-web"), false);
});

// ── Small requests are unchanged ───────────────────────────────────────────

test("small request within budget is unchanged", () => {
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello, world!" },
  ];
  const result = truncateMessagesForWebProvider(messages, CONTEXT_LIMIT);
  assert.equal(result.length, 2);
  assert.equal(result[0].content, "You are a helpful assistant.");
  assert.equal(result[1].content, "Hello, world!");
});

// ── Oversized system prompt ────────────────────────────────────────────────

test("oversized system prompt is truncated to MAX_SYSTEM_CHARS", () => {
  const hugeSystem = "A".repeat(50_000); // 50K chars, well over 12K limit
  const messages = [
    { role: "system", content: hugeSystem },
    { role: "user", content: "What is 2+2?" },
  ];
  const result = truncateMessagesForWebProvider(messages, CONTEXT_LIMIT);
  const sysContent = result[0].content as string;
  assert.ok(
    sysContent.length <= 12_000 + 50,
    `system prompt should be ~12K, got ${sysContent.length}`
  );
  assert.ok(sysContent.includes("[...truncated...]"), "should have truncation marker");
  // User message preserved
  assert.equal(result[1].content, "What is 2+2?");
});

// ── Oversized current user message ─────────────────────────────────────────

test("oversized current user message is truncated", () => {
  const hugeUser = "X".repeat(60_000); // 60K chars, well over 20K limit
  const messages = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: hugeUser },
  ];
  const result = truncateMessagesForWebProvider(messages, CONTEXT_LIMIT);
  const userContent = result[result.length - 1].content as string;
  assert.ok(
    userContent.length <= 20_000 + 50,
    `current message should be ~20K, got ${userContent.length}`
  );
  assert.ok(userContent.includes("[...truncated...]"), "should have truncation marker");
});

// ── Oversized history ──────────────────────────────────────────────────────

test("oversized history is trimmed from the front (oldest first)", () => {
  // System + 10 history pairs + current user = 22 messages
  // Each history message is 20K chars → 200K chars of history alone = ~50K tokens
  // Well over the 40K token limit (34K input budget = 136K chars)
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "You are helpful." },
  ];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "user", content: `Question ${i}: ` + "Q".repeat(20_000) });
    messages.push({ role: "assistant", content: `Answer ${i}: ` + "A".repeat(20_000) });
  }
  messages.push({ role: "user", content: "Final question" });

  const result = truncateMessagesForWebProvider(messages, CONTEXT_LIMIT);

  // System prompt should be preserved
  assert.equal(result[0].role, "system");
  assert.equal(result[0].content, "You are helpful.");

  // Last message should be preserved
  assert.equal(result[result.length - 1].content, "Final question");

  // Total should be within budget (40K tokens * 0.85 = 34K input * 4 chars = 136K chars)
  const totalChars = result.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0
  );
  const budgetChars = Math.floor(CONTEXT_LIMIT * 0.85) * 4;
  assert.ok(
    totalChars <= budgetChars + 1000,
    `total chars ${totalChars} should be within budget ${budgetChars}`
  );

  // Should have dropped some history (fewer than original 22 messages)
  assert.ok(result.length < 22, `should have dropped some history, got ${result.length} messages`);
});

// ── Combined payload: huge system + huge current + history ─────────────────

test("combined huge payload fits within budget after truncation", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "S".repeat(80_000) }, // 80K char system prompt
  ];
  for (let i = 0; i < 5; i++) {
    messages.push({ role: "user", content: "U".repeat(30_000) });
    messages.push({ role: "assistant", content: "A".repeat(30_000) });
  }
  messages.push({ role: "user", content: "C".repeat(80_000) }); // 80K char current message

  // Total: 80K + 300K history + 80K = 460K chars = ~115K tokens — way over 40K
  const result = truncateMessagesForWebProvider(messages, CONTEXT_LIMIT);

  const totalChars = result.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0
  );
  const totalTokens = Math.ceil(totalChars / 4);
  assert.ok(
    totalTokens <= CONTEXT_LIMIT,
    `total tokens ${totalTokens} should be within limit ${CONTEXT_LIMIT}`
  );

  // System prompt should be truncated
  const sysContent = result[0].content as string;
  assert.ok(sysContent.length <= 12_000 + 50, "system should be truncated");

  // Last message should be present
  assert.equal(result[result.length - 1].role, "user");
});

// ── Array content format ───────────────────────────────────────────────────

test("array content format is handled correctly", () => {
  const messages = [
    {
      role: "system",
      content: [{ type: "text", text: "S".repeat(50_000) }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    },
  ];
  const result = truncateMessagesForWebProvider(messages, CONTEXT_LIMIT);
  // System should be truncated
  const sysContent = result[0].content;
  if (typeof sysContent === "string") {
    assert.ok(sysContent.length <= 12_000 + 50);
  } else if (Array.isArray(sysContent)) {
    const text = (sysContent[0] as { text: string }).text;
    assert.ok(text.length <= 12_000 + 50);
  }
  // User should be preserved
  assert.equal(result.length, 2);
});

// ── Empty messages ─────────────────────────────────────────────────────────

test("empty messages array is returned as-is", () => {
  const result = truncateMessagesForWebProvider([], CONTEXT_LIMIT);
  assert.equal(result.length, 0);
});

// ── Single message ─────────────────────────────────────────────────────────

test("single oversized user message is truncated to fit", () => {
  const messages = [
    { role: "user", content: "Z".repeat(200_000) }, // 200K chars = 50K tokens
  ];
  const result = truncateMessagesForWebProvider(messages, CONTEXT_LIMIT);
  const content = result[0].content as string;
  const tokens = Math.ceil(content.length / 4);
  assert.ok(tokens <= CONTEXT_LIMIT, `tokens ${tokens} should be within limit ${CONTEXT_LIMIT}`);
  assert.ok(content.includes("[...truncated...]"), "should have truncation marker");
});

// ── System + single user only (no history) ─────────────────────────────────

test("system + single oversized user fits within budget", () => {
  const messages = [
    { role: "system", content: "S".repeat(30_000) },
    { role: "user", content: "U".repeat(100_000) },
  ];
  const result = truncateMessagesForWebProvider(messages, CONTEXT_LIMIT);
  assert.equal(result.length, 2);
  const totalChars = result.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0
  );
  const totalTokens = Math.ceil(totalChars / 4);
  assert.ok(
    totalTokens <= CONTEXT_LIMIT,
    `total tokens ${totalTokens} should be within limit ${CONTEXT_LIMIT}`
  );
});
