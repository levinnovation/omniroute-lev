import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureToolCallIds,
  stripOrphanedToolResults,
} from "../../open-sse/translator/helpers/toolCallHelper.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

test("Cursor history without assistant calls preserves every tool result as labelled context", () => {
  const outputs = ["search result", "file contents", "second search", "second file"];
  const body = {
    messages: [
      { role: "user", content: "Compare the files." },
      { role: "assistant", content: "I will check." },
      ...outputs.slice(0, 2).map((content) => ({ role: "tool", content })),
      { role: "assistant", content: "" },
      ...outputs.slice(2).map((content) => ({ role: "tool", content })),
    ],
  };

  stripOrphanedToolResults(body);
  assert.equal(
    body.messages.some((message) => message.role === "tool"),
    false
  );
  const results = body.messages.filter((message) => message.content.startsWith("[Tool Result"));
  assert.equal(results.length, outputs.length);
  for (const [index, result] of results.entries()) {
    assert.equal(result.role, "user");
    assert.ok(result.content.endsWith(outputs[index]));
  }
  const normalized = structuredClone(body);
  stripOrphanedToolResults(body);
  assert.deepEqual(body, normalized);
});

test("missing and blank tool IDs preserve structured output without inventing calls", () => {
  const content = [{ type: "tool_result", content: [{ type: "text", text: "file data" }] }];
  for (const id of [undefined, null, "", "   "]) {
    const body = { messages: [{ role: "tool", tool_call_id: id, content }] };
    stripOrphanedToolResults(body);
    assert.equal(body.messages[0].role, "user");
    assert.equal("tool_call_id" in body.messages[0], false);
    assert.ok(String(body.messages[0].content).endsWith(JSON.stringify(content)));
  }
});

test("a missing result ID still binds to an available assistant call before orphan handling", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_read", type: "function", function: { name: "Read", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "file data" },
    ],
  };
  ensureToolCallIds(body);
  stripOrphanedToolResults(body);
  assert.equal(body.messages[1].role, "tool");
  assert.equal(body.messages[1]["tool_call_id"], "call_read");
});

test("OpenAI passthrough to Sophea repairs Cursor tool continuations", () => {
  const output = JSON.stringify([{ type: "text", text: "The marker is WARRANTY_OK_42." }]);
  const body = {
    model: "qwen4-max:free",
    messages: [
      { role: "user", content: "What marker was found?" },
      { role: "assistant", content: "I will check." },
      { role: "tool", content: output },
    ],
  };
  const result = translateRequest(
    FORMATS.OPENAI,
    FORMATS.OPENAI,
    body.model,
    body,
    false,
    null,
    "openai-compatible-chat-sophea"
  );
  assert.equal(
    result.messages.some((message) => message.role === "tool"),
    false
  );
  assert.equal(result.messages.at(-1).role, "user");
  assert.ok(result.messages.at(-1).content.endsWith(output));
});
