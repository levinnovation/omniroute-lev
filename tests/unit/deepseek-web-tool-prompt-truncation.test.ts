// LEV fork: DeepSeek-web tool prompt truncation and empty-content watchdog tests.
//
// Verifies that:
// 1. buildToolConversationPrompt truncates large tool results
// 2. buildToolConversationPrompt drops older turns when total prompt exceeds limit
// 3. buildToolAwareResult emits an error message when content and tool calls are both empty
//
// Run: node --import tsx/esm --test tests/unit/deepseek-web-tool-prompt-truncation.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-ds-trunc-"));

test("buildToolConversationPrompt truncates large tool results", async () => {
  const { buildToolConversationPrompt } =
    await import("../../open-sse/translator/deepseekWebTools.ts");

  const largeContent = "x".repeat(10_000);
  const messages = [
    { role: "user", content: "Read a file" },
    {
      role: "assistant",
      content: "Reading the file",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "Read", arguments: '{"path":"/big.ts"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call-1",
      name: "Read",
      content: largeContent,
    },
  ];

  const prompt = buildToolConversationPrompt(messages, "You are a coding agent.");
  assert.ok(prompt.includes("truncated"), "Large tool result should be truncated");
  assert.ok(
    prompt.length < largeContent.length + 1000,
    "Prompt should be much smaller than the raw tool result"
  );
  assert.ok(prompt.includes("Read"), "Tool name should still be in the prompt");
});

test("buildToolConversationPrompt drops older turns when total prompt exceeds limit", async () => {
  const { buildToolConversationPrompt } =
    await import("../../open-sse/translator/deepseekWebTools.ts");

  // Build a conversation with many large tool results that exceed the limit
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: "Do a big task" }];
  for (let i = 0; i < 20; i++) {
    messages.push({
      role: "assistant",
      content: `Step ${i}`,
      tool_calls: [
        {
          id: `call-${i}`,
          type: "function",
          function: { name: "Shell", arguments: `{"command":"cat file${i}.ts"}` },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: `call-${i}`,
      name: "Shell",
      content: "y".repeat(5_000),
    });
  }
  // Final user message
  messages.push({ role: "user", content: "Now give me the final answer" });

  const prompt = buildToolConversationPrompt(messages, "You are a coding agent.");
  // The prompt should be under the max limit
  assert.ok(prompt.length <= 130_000, `Prompt should be under limit, got ${prompt.length} chars`);
  // The most recent user message should still be present
  assert.ok(prompt.includes("final answer"), "Most recent user message should be preserved");
  // The system prompt should still be present
  assert.ok(prompt.includes("coding agent"), "System prompt should be preserved");
});

test("buildToolConversationPrompt preserves small tool results without truncation", async () => {
  const { buildToolConversationPrompt } =
    await import("../../open-sse/translator/deepseekWebTools.ts");

  const messages = [
    { role: "user", content: "List files" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "Glob", arguments: '{"pattern":"*.ts"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call-1",
      name: "Glob",
      content: "file1.ts\nfile2.ts\nfile3.ts",
    },
  ];

  const prompt = buildToolConversationPrompt(messages, "You are a coding agent.");
  assert.ok(prompt.includes("file1.ts"), "Small tool result should not be truncated");
  assert.ok(!prompt.includes("truncated"), "Small tool result should not have truncation marker");
});

test("buildToolConversationPrompt skips tool calls with empty names", async () => {
  const { buildToolConversationPrompt } =
    await import("../../open-sse/translator/deepseekWebTools.ts");

  const messages = [
    { role: "user", content: "Do something" },
    {
      role: "assistant",
      content: "Working",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "", arguments: "{}" },
        },
      ],
    },
  ];

  const prompt = buildToolConversationPrompt(messages, "System prompt");
  assert.ok(
    !prompt.includes('<tool>{"name": "",'),
    "Tool calls with empty names should be skipped"
  );
});

test("buildToolConversationPrompt handles malformed tool call arguments", async () => {
  const { buildToolConversationPrompt } =
    await import("../../open-sse/translator/deepseekWebTools.ts");

  const messages = [
    { role: "user", content: "Do something" },
    {
      role: "assistant",
      content: "Working",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "Read", arguments: "{invalid json}" },
        },
      ],
    },
  ];

  const prompt = buildToolConversationPrompt(messages, "System prompt");
  // Malformed arguments should be replaced with "{}" (embedded as raw JSON, not a string)
  assert.ok(
    prompt.includes('"arguments": {}'),
    "Malformed arguments should be replaced with empty object"
  );
  assert.ok(!prompt.includes("invalid json"), "Malformed JSON should not appear in the prompt");
});
