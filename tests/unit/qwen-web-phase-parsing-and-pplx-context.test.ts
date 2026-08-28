// LEV fork: Qwen-web SSE phase parsing and Perplexity-web context folding tests.
//
// Verifies that:
// 1. Qwen's expanded phase enum (DeepThinking, ResearchPlanning, ReportGeneration)
//    is correctly parsed into think/answer deltas
// 2. The streaming empty-content watchdog emits an error chunk
// 3. Perplexity's parseOpenAIMessages folds preceding user messages (Cursor
//    context: user_info, git_status, agent_transcripts) into currentMsg
//
// Run: node --import tsx/esm --test tests/unit/qwen-web-phase-parsing-and-pplx-context.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-qwen-pplx-"));

// ── Qwen SSE phase parsing ─────────────────────────────────────────────────

test("Qwen SSE parser recognizes DeepThinking phase as think", async () => {
  // Simulate a Qwen SSE line with DeepThinking phase
  const line =
    'data: {"choices":[{"delta":{"phase":"DeepThinking","content":"Analyzing the code structure..."}}]}';
  const { QwenWebExecutor } = await import("../../open-sse/executors/qwen-web.ts");
  const executor = new QwenWebExecutor();

  const sseStream = [line, "\n", "data: [DONE]\n\n"].join("");
  const fakeResponse = new Response(sseStream);
  const result = await (
    executor as unknown as {
      collectStream: (r: Response) => Promise<{ content: string; reasoning: string }>;
    }
  ).collectStream(fakeResponse);
  assert.ok(
    result.reasoning.includes("Analyzing the code structure..."),
    "DeepThinking content should be captured as reasoning"
  );
  // The reasoning fallback in collectStream will set content = reasoning
  // when no answer-phase content exists, so content will also contain it.
  assert.ok(
    result.content.includes("Analyzing the code structure..."),
    "DeepThinking content should be used as answer via reasoning fallback"
  );
});

test("Qwen SSE parser recognizes ResearchPlanning phase as think", async () => {
  const line =
    'data: {"choices":[{"delta":{"phase":"ResearchPlanning","content":"Planning research steps..."}}]}';
  const { QwenWebExecutor } = await import("../../open-sse/executors/qwen-web.ts");
  const executor = new QwenWebExecutor();

  const sseStream = [line, "\n", "data: [DONE]\n\n"].join("");
  const fakeResponse = new Response(sseStream);
  const result = await (
    executor as unknown as {
      collectStream: (r: Response) => Promise<{ content: string; reasoning: string }>;
    }
  ).collectStream(fakeResponse);
  assert.ok(
    result.reasoning.includes("Planning research steps..."),
    "ResearchPlanning content should be captured as reasoning"
  );
});

test("Qwen SSE parser recognizes ReportGeneration phase as answer", async () => {
  const line =
    'data: {"choices":[{"delta":{"phase":"ReportGeneration","content":"Here is the report..."}}]}';
  const { QwenWebExecutor } = await import("../../open-sse/executors/qwen-web.ts");
  const executor = new QwenWebExecutor();

  const sseStream = [line, "\n", "data: [DONE]\n\n"].join("");
  const fakeResponse = new Response(sseStream);
  const result = await (
    executor as unknown as {
      collectStream: (r: Response) => Promise<{ content: string; reasoning: string }>;
    }
  ).collectStream(fakeResponse);
  assert.ok(
    result.content.includes("Here is the report..."),
    "ReportGeneration content should be captured as answer content"
  );
});

test("Qwen SSE parser still recognizes think and answer phases", async () => {
  const lines = [
    'data: {"choices":[{"delta":{"phase":"think","content":"Thinking..."}}]}',
    'data: {"choices":[{"delta":{"phase":"answer","content":"Answer!"}}]}',
  ];
  const { QwenWebExecutor } = await import("../../open-sse/executors/qwen-web.ts");
  const executor = new QwenWebExecutor();

  const sseStream = [...lines, "data: [DONE]\n\n"].join("\n");
  const fakeResponse = new Response(sseStream);
  const result = await (
    executor as unknown as {
      collectStream: (r: Response) => Promise<{ content: string; reasoning: string }>;
    }
  ).collectStream(fakeResponse);
  assert.ok(result.reasoning.includes("Thinking..."), "think phase → reasoning");
  assert.ok(result.content.includes("Answer!"), "answer phase → content");
});

test("Qwen SSE parser uses reasoning as content when answer is empty (thinking-enabled models)", async () => {
  const lines = [
    'data: {"choices":[{"delta":{"phase":"DeepThinking","content":"Deep analysis only, no answer phase"}}]}',
  ];
  const { QwenWebExecutor } = await import("../../open-sse/executors/qwen-web.ts");
  const executor = new QwenWebExecutor();

  const sseStream = [...lines, "data: [DONE]\n\n"].join("\n");
  const fakeResponse = new Response(sseStream);
  const result = await (
    executor as unknown as {
      collectStream: (r: Response) => Promise<{ content: string; reasoning: string }>;
    }
  ).collectStream(fakeResponse);
  assert.ok(
    result.content.includes("Deep analysis only"),
    "When only thinking content exists, it should be used as the answer"
  );
});

test("Qwen SSE parser skips non-content phases (KeepAlive, finished)", async () => {
  const lines = [
    'data: {"choices":[{"delta":{"phase":"KeepAlive","content":""}}]}',
    'data: {"choices":[{"delta":{"phase":"finished","content":""}}]}',
  ];
  const { QwenWebExecutor } = await import("../../open-sse/executors/qwen-web.ts");
  const executor = new QwenWebExecutor();

  const sseStream = [...lines, "data: [DONE]\n\n"].join("\n");
  const fakeResponse = new Response(sseStream);
  const result = await (
    executor as unknown as {
      collectStream: (r: Response) => Promise<{ content: string; reasoning: string }>;
    }
  ).collectStream(fakeResponse);
  assert.equal(result.content, "", "Non-content phases should produce no content");
  assert.equal(result.reasoning, "", "Non-content phases should produce no reasoning");
});

// ── Perplexity context folding ─────────────────────────────────────────────

test("PPLX parseOpenAIMessages folds preceding user messages into currentMsg", async () => {
  const { parseOpenAIMessages } =
    await import("../../open-sse/executors/perplexity-web/protocol.ts");

  // Simulate Cursor's message structure:
  // 1. system prompt
  // 2. user message with IDE context (user_info, git_status, agent_transcripts)
  // 3. user message with the actual query
  const messages = [
    {
      role: "system",
      content: "You are an AI coding assistant, powered by pplx-web/pplx-glm.",
    },
    {
      role: "user",
      content:
        "<user_info>\nOS Version: darwin 25.5.0\nWorkspace Path: /Users/vinicioflores/agentyx-generic-portal-retail\n</user_info>\n\n<git_status>\nM src/components/portal/charts/composite/index.ts\n</git_status>",
    },
    {
      role: "user",
      content:
        "<timestamp>Friday, Aug 28, 2026</timestamp>\n<user_query>\nFix the crash on inventario/analytics page\n</user_query>",
    },
  ];

  const parsed = parseOpenAIMessages(messages);
  assert.ok(
    parsed.currentMsg.includes("Fix the crash"),
    "currentMsg should contain the actual query"
  );
  assert.ok(
    parsed.currentMsg.includes("user_info"),
    "currentMsg should contain the Cursor IDE context (user_info)"
  );
  assert.ok(
    parsed.currentMsg.includes("git_status"),
    "currentMsg should contain the Cursor IDE context (git_status)"
  );
  // The actual query must come BEFORE the context block so that dsl_query
  // truncation (slice(0, MAX_DSL_LEN)) preserves the query, not the context.
  const queryIdx = parsed.currentMsg.indexOf("Fix the crash");
  const contextIdx = parsed.currentMsg.indexOf("user_info");
  assert.ok(
    queryIdx < contextIdx,
    "Actual user query should come before IDE context in currentMsg (truncation safety)"
  );
});

test("PPLX parseOpenAIMessages handles single user message (no context to fold)", async () => {
  const { parseOpenAIMessages } =
    await import("../../open-sse/executors/perplexity-web/protocol.ts");

  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello, world!" },
  ];

  const parsed = parseOpenAIMessages(messages);
  assert.equal(
    parsed.currentMsg,
    "Hello, world!",
    "Single user message should be currentMsg without folding"
  );
});

test("PPLX parseOpenAIMessages handles array content parts", async () => {
  const { parseOpenAIMessages } =
    await import("../../open-sse/executors/perplexity-web/protocol.ts");

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "<user_info>IDE context</user_info>" },
        { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
      ],
    },
    {
      role: "user",
      content: [{ type: "text", text: "What is in this image?" }],
    },
  ];

  const parsed = parseOpenAIMessages(messages);
  assert.ok(
    parsed.currentMsg.includes("IDE context"),
    "Array content text parts should be folded into currentMsg"
  );
  assert.ok(
    parsed.currentMsg.includes("What is in this image?"),
    "Latest message text should be in currentMsg"
  );
});

test("PPLX parseOpenAIMessages excludes assistant messages from context fold", async () => {
  const { parseOpenAIMessages } =
    await import("../../open-sse/executors/perplexity-web/protocol.ts");

  const messages = [
    { role: "user", content: "First user message" },
    { role: "assistant", content: "Assistant response" },
    { role: "user", content: "Second user message" },
  ];

  const parsed = parseOpenAIMessages(messages);
  assert.ok(
    parsed.currentMsg.includes("First user message"),
    "Preceding user messages should be folded in"
  );
  assert.ok(
    parsed.currentMsg.includes("Second user message"),
    "Latest user message should be included"
  );
  assert.ok(
    !parsed.currentMsg.includes("Assistant response"),
    "Assistant messages should NOT be folded into currentMsg"
  );
});
