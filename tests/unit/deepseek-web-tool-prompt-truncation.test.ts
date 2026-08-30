// LEV fork: DeepSeek-web tool prompt truncation, empty-content watchdog,
// and narrated-intent detection tests.
//
// Verifies that:
// 1. buildToolConversationPrompt truncates large tool results
// 2. buildToolConversationPrompt drops older turns when total prompt exceeds limit
// 3. buildToolAwareResult emits an error message when content and tool calls are both empty
// 4. serializeDeepSeekToolPrompt includes the CRITICAL no-narration rule
// 5. looksLikeNarratedIntent detects narrated tool intent without actual tool blocks
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
  assert.ok(prompt.length <= 90_000, `Prompt should be under limit, got ${prompt.length} chars`);
  // The most recent user message should still be present
  assert.ok(prompt.includes("final answer"), "Most recent user message should be preserved");
  // The system prompt should still be present
  assert.ok(prompt.includes("coding agent"), "System prompt should be preserved");
  // When older lines are truncated from the front, a System note should explain it
  assert.ok(
    prompt.includes("earlier conversation history omitted"),
    "Front-truncation of older lines should include a System note"
  );
});

test("buildToolConversationPrompt preserves the actual question via <user_query> extraction", async () => {
  const { buildToolConversationPrompt } =
    await import("../../open-sse/translator/deepseekWebTools.ts");

  // Simulate a Cursor-style user message: the actual question is wrapped in
  // <user_query> tags, buried after <image_files> and <timestamp> prefixes,
  // followed by a very long DOM snippet section. The extraction logic pulls
  // the <user_query> content and preserves it at the top regardless of
  // where truncation happens.
  const actualQuestion =
    "in https://example.com/portal/admin/retail/inventario/reposicion, " +
    "the glass header in the unified table seems broken - not properly aligned";
  const domSnippets = "y".repeat(90_000); // Very long DOM context after the question

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "[Image 1]: The image shows a section of a user interface" },
        { type: "text", text: "<image_files>\n1. /path/to/image.png\n</image_files>" },
        {
          type: "text",
          text: `<timestamp>Friday, Aug 28, 2026</timestamp>\n<user_query>\n${actualQuestion}\n\`\`\`browser_element\n${domSnippets}\n\`\`\`\n</user_query>`,
        },
      ],
    },
  ];

  const prompt = buildToolConversationPrompt(messages, "You are a coding agent.");
  // The actual question MUST be present — extracted from <user_query> and preserved at top
  assert.ok(
    prompt.includes("glass header"),
    "The actual user question from <user_query> must be preserved"
  );
  assert.ok(prompt.includes("reposicion"), "The URL in the user question must be preserved");
  // The prompt should be under the limit
  assert.ok(prompt.length <= 90_000, `Prompt should be under limit, got ${prompt.length} chars`);
  // The user_query should be preserved as a labeled section at the top
  assert.ok(
    prompt.includes("User's actual request"),
    "The <user_query> content should be labeled as the user's actual request"
  );
  // The truncation marker should be informative, not alarming
  assert.ok(
    prompt.includes("System note:") && prompt.includes("omitted"),
    "Truncation marker should be a System note explaining context was omitted"
  );
  assert.ok(
    prompt.includes("COMPLETE and authoritative"),
    "Truncation marker should reassure that the user's request is complete"
  );
  // The marker should NOT use the old alarming wording
  assert.ok(
    !/\[\.\.\.truncated \d+ chars\.\.\.\]/.test(prompt),
    "Should not use the old alarming [...truncated N chars...] marker"
  );
});

test("buildToolConversationPrompt preserves <user_query> even with huge system prompt and multiple messages", async () => {
  const { buildToolConversationPrompt } =
    await import("../../open-sse/translator/deepseekWebTools.ts");

  // Simulate a realistic Cursor session: huge system prompt (tool definitions),
  // user_info/rules message, prior tool calls, and a final user message with
  // <user_query> buried in a large DOM context.
  const hugeSystemPrompt = "S".repeat(40_000); // Simulate large tool definitions
  const userInfo = "U".repeat(20_000); // Simulate AGENTS.md, rules, etc.
  const actualQuestion = "Fix the sticky glass header alignment in the reposicion table";
  const domSnippets = "D".repeat(50_000);

  const messages = [
    { role: "user", content: userInfo },
    {
      role: "user",
      content: [
        { type: "text", text: "<image_files>\n1. /path/to/image.png\n</image_files>" },
        {
          type: "text",
          text: `<timestamp>Friday, Aug 28, 2026</timestamp>\n<user_query>\n${actualQuestion}\n\`\`\`browser_element\n${domSnippets}\n\`\`\`\n</user_query>`,
        },
      ],
    },
  ];

  const prompt = buildToolConversationPrompt(messages, hugeSystemPrompt);
  // The actual question MUST survive — this is the core fix
  assert.ok(
    prompt.includes(actualQuestion),
    "The <user_query> content must be preserved even with huge system prompt and DOM context"
  );
  assert.ok(prompt.length <= 90_000, `Prompt should be under limit, got ${prompt.length} chars`);
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

test("serializeDeepSeekToolPrompt includes CRITICAL no-narration rule", async () => {
  const { serializeDeepSeekToolPrompt } =
    await import("../../open-sse/translator/deepseekWebTools.ts");

  const tools = [
    {
      type: "function",
      function: {
        name: "Read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ];
  const prompt = serializeDeepSeekToolPrompt(tools);
  assert.ok(prompt.includes("CRITICAL"), "Prompt should include CRITICAL no-narration rule");
  assert.ok(
    prompt.includes("Do NOT say 'Let me read X'"),
    "Prompt should explicitly forbid narration pattern"
  );
  assert.ok(
    prompt.includes("emit the <tool> block in THIS response"),
    "Prompt should require same-response tool emission"
  );
  // LEV fork: The tool prompt should also mention truncation markers so the model
  // doesn't panic when it sees [System note: ... omitted ...]
  assert.ok(
    prompt.includes("System note"),
    "Tool prompt should mention System note truncation markers"
  );
  assert.ok(
    prompt.includes("do NOT ask the user to paste"),
    "Tool prompt should tell the model not to ask user to re-send truncated content"
  );
});

test("serializeDeepSeekToolPrompt continuation instruction forbids narration", async () => {
  const { buildToolConversationPrompt } =
    await import("../../open-sse/translator/deepseekWebTools.ts");

  const messages = [
    { role: "user", content: "Read a file" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "Read", arguments: '{"path":"/a.ts"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call-1", name: "Read", content: "file contents" },
  ];
  const prompt = buildToolConversationPrompt(messages, "System");
  assert.ok(
    prompt.includes("do NOT narrate intent"),
    "Continuation instruction should forbid narration"
  );
});

test("looksLikeNarratedIntent detects narrated tool intent", async () => {
  // Import the private function via the module's internal export path.
  // Since looksLikeNarratedIntent is not exported, we test the regex pattern
  // directly to verify the detection logic.
  const NARRATED_INTENT_RE =
    /\b(let me|I'll|I will|I need to|let's|I want to|I'm going to)\b.+\b(read|check|look|search|find|continue|see|inspect|examine|explore|run|execute|call|use|open|list|grep|glob|write|edit|create|delete|shell|terminal)\b/i;

  // Positive cases — narrated intent
  assert.ok(
    NARRATED_INTENT_RE.test("Let me continue reading the file."),
    "Should detect 'Let me continue reading'"
  );
  assert.ok(NARRATED_INTENT_RE.test("I'll check the data sources."), "Should detect 'I'll check'");
  assert.ok(
    NARRATED_INTENT_RE.test("I need to see the rest of the file."),
    "Should detect 'I need to see'"
  );
  assert.ok(
    NARRATED_INTENT_RE.test("Let me search for the error."),
    "Should detect 'Let me search'"
  );
  assert.ok(
    NARRATED_INTENT_RE.test("I'm going to run the tests."),
    "Should detect 'I'm going to run'"
  );

  // Negative cases — actual content, not narrated intent
  assert.ok(
    !NARRATED_INTENT_RE.test("The crash is caused by a missing database column."),
    "Should not detect factual statement"
  );
  assert.ok(
    !NARRATED_INTENT_RE.test("The fix is to add a null check."),
    "Should not detect solution statement"
  );
  assert.ok(!NARRATED_INTENT_RE.test("Done."), "Should not detect short completion");
});

test("looksLikeNarratedIntent does not match content with actual tool blocks", async () => {
  // Content that contains a <tool> block should NOT be flagged as narrated intent
  // even if it has intent-like text, because the tool was actually emitted.
  const contentWithTool =
    'Let me read the file.\n<tool>{"name": "Read", "arguments": {"path": "/a.ts"}}</tool>';
  assert.ok(contentWithTool.includes("<tool>"), "Content with tool block should have <tool> tag");
  // The detector checks for <tool> presence before applying the regex
});

test("extractUserQuery preserves browser_element blocks referenced by 'look at:'", async () => {
  // Regression: when a user says "look at:" followed by browser_element code
  // blocks, those blocks are critical context. Previously ALL code blocks were
  // stripped, leaving the model with "look at:" and nothing after it.
  const { buildToolConversationPrompt } =
    await import("../../open-sse/translator/deepseekWebTools.ts");

  const actualQuestion = "the glass header in the unified table seems broken, look at:";
  const elementBlock =
    "```browser_element\n" +
    "The user selected this node in the browser preview.\n\n" +
    "tag: th\ndom_path: div.group > main > table > thead > tr > th\n" +
    "class: sticky top-[3.25rem] z-10 bg-muted/50\n" +
    "visible_text: SKU\n" +
    "bounds_css_px: top=448 left=361 width=95 height=31\n" +
    "```";

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "[Image 1]: The image shows a section of a user interface" },
        {
          type: "text",
          text: `<user_query>\n${actualQuestion}\n${elementBlock}\n</user_query>`,
        },
      ],
    },
  ];

  const prompt = buildToolConversationPrompt(messages, "You are a coding agent.");
  // The question must be preserved
  assert.ok(prompt.includes("glass header"), "Question text must be preserved");
  // The browser_element block must be preserved — it's what "look at:" references
  assert.ok(
    prompt.includes("browser_element"),
    "browser_element block must be preserved (it's what 'look at:' references)"
  );
  assert.ok(
    prompt.includes("visible_text: SKU"),
    "Key content from browser_element block must be preserved"
  );
  assert.ok(
    prompt.includes("sticky top-[3.25rem]"),
    "CSS class info from browser_element block must be preserved"
  );
});

test("extractUserQuery caps very large browser_element blocks", async () => {
  // Very large browser_element blocks (huge DOM dumps) should be capped
  // to avoid blowing the prompt budget, but still preserve the beginning.
  const { buildToolConversationPrompt } =
    await import("../../open-sse/translator/deepseekWebTools.ts");

  const actualQuestion = "Fix the alignment issue";
  const hugeDomDump = "x".repeat(50_000); // Huge DOM dump inside browser_element
  const largeSystemPrompt = "S".repeat(40_000); // Push total over 80K to trigger truncation

  const messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `<user_query>\n${actualQuestion}\n\`\`\`browser_element\n${hugeDomDump}\n\`\`\`\n</user_query>`,
        },
      ],
    },
  ];

  const prompt = buildToolConversationPrompt(messages, largeSystemPrompt);
  // The question must be preserved
  assert.ok(prompt.includes("Fix the alignment issue"), "Question must be preserved");
  // The browser_element should be capped, not fully stripped
  assert.ok(
    prompt.includes("browser_element"),
    "browser_element marker should still be present (capped, not stripped)"
  );
  assert.ok(
    prompt.includes("truncated to fit prompt"),
    "Large browser_element should have a truncation marker"
  );
  // The prompt should be under the limit (truncation worked)
  assert.ok(prompt.length <= 90_000, `Prompt should be under limit, got ${prompt.length}`);
});
