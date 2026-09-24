// gemini-web multipart + tool-history prompt fix.
//
// Production incident (2026-09-24): opencode sent a 27K-token request —
// system prompt, a user turn with multipart array content, an assistant
// `tool_calls` turn, and a `role:"tool"` result — and gemini-web answered
// "Ready." (2 output tokens). Root cause: the prompt builders kept only
// `typeof content === "string"` messages, so the user ask (array content),
// the assistant tool_calls, and the tool result were ALL dropped; Gemini saw
// a system-only prompt with nothing to do and acknowledged it. The fix folds
// `flattenToolHistory()` into the builders (ADR-001 pattern, already used by
// 8 other web-cookie providers) and extracts text from multipart content.

import test from "node:test";
import assert from "node:assert/strict";

const { buildGeminiPrompt, buildGeminiToolPrompt } =
  await import("../../open-sse/executors/gemini-web.ts");

// Mirrors the logged opencode payload: multipart user content, then an
// assistant tool_calls turn + tool result AFTER the last user message.
function opencodeShapeMessages() {
  return [
    { role: "system", content: "You are opencode, an interactive CLI agent." },
    {
      role: "user",
      content: [
        { type: "text", text: "hey lets analyze the architecture of this core portal " },
        { type: "text", text: "<system-reminder>plan mode active</system-reminder>" },
      ],
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "gwe-1_0",
          type: "function",
          function: { name: "codebase-memory-mcp_list_projects", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "gwe-1_0",
      content: '{"projects":[{"name":"portal","nodes":9780}]}',
    },
  ] as Array<{ role: string; content: unknown }>;
}

test("multipart array user content is extracted instead of dropped", () => {
  const prompt = buildGeminiPrompt([
    {
      role: "user",
      content: [
        { type: "text", text: "first part" },
        { type: "text", text: "second part" },
      ],
    },
  ]);
  assert.equal(prompt, "first part\nsecond part");
});

test("incident shape: tool-mode prompt carries user ask + tool call + tool result", () => {
  const effectiveMessages = [
    ...opencodeShapeMessages(),
    { role: "system", content: "TOOL CONTRACT" },
  ];
  const prompt = buildGeminiToolPrompt(effectiveMessages);

  assert.match(prompt, /TOOL CONTRACT/);
  assert.match(prompt, /You are opencode/);
  assert.match(prompt, /analyze the architecture of this core portal/);
  assert.match(prompt, /Called tools: codebase-memory-mcp_list_projects/);
  assert.match(prompt, /Tool result: \{"projects":\[\{"name":"portal","nodes":9780\}\]\}/);
  // The tool result must land AFTER the current user message so the model
  // reacts to it instead of re-issuing the same tool call.
  assert.ok(
    prompt.indexOf("Tool result:") > prompt.indexOf("Current user message:"),
    "tool result should trail the current user message"
  );
});

test("incident shape: no-tools path also preserves the in-flight tool exchange", () => {
  const prompt = buildGeminiPrompt(opencodeShapeMessages());

  assert.match(prompt, /analyze the architecture of this core portal/);
  assert.match(prompt, /Called tools: codebase-memory-mcp_list_projects/);
  assert.match(prompt, /Tool result:/);
  assert.ok(
    prompt.indexOf("Tool result:") > prompt.indexOf("Current user message:"),
    "tool result should trail the current user message"
  );
});

test("multi-turn ordering: prior turns, current user, then post-user tool turns", () => {
  const prompt = buildGeminiPrompt([
    { role: "user", content: "remember: my city is Berlin" },
    { role: "assistant", content: "Got it." },
    { role: "user", content: "what's the weather?" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "sunny, 22C" },
  ]);

  const prevIdx = prompt.indexOf("Previous conversation:");
  const curIdx = prompt.indexOf("Current user message:");
  const toolIdx = prompt.indexOf("sunny, 22C");
  assert.ok(prevIdx !== -1 && curIdx !== -1 && toolIdx !== -1);
  assert.ok(prevIdx < curIdx && curIdx < toolIdx);
  assert.match(prompt, /Berlin/);
});

test("single-turn string message stays byte-for-byte (regression guard)", () => {
  assert.equal(
    buildGeminiPrompt([{ role: "user", content: "What about Paris?" }]),
    "What about Paris?"
  );
  assert.equal(buildGeminiToolPrompt([{ role: "user", content: "hello" }]), "hello");
});
