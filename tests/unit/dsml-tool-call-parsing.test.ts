import test from "node:test";
import assert from "node:assert/strict";

import {
  parseTextualToolCallCandidate,
  containsTextualToolCallMarker,
  stripZeroWidth,
} from "../../open-sse/utils/textualToolCall.ts";

// DSML marker — U+FF5C fullwidth vertical line
const DSML = "\uff5c";
const DSML_INVOKE_OPEN = `<${DSML}DSML${DSML}invoke`;
const DSML_INVOKE_CLOSE = `<${DSML}DSML${DSML}/invoke>`;
const DSML_PARAM_OPEN = `<${DSML}DSML${DSML}parameter`;
const DSML_PARAM_CLOSE = `<${DSML}DSML${DSML}/parameter>`;
const DSML_TC_OPEN = `<${DSML}DSML${DSML}tool_calls>`;
const DSML_TC_CLOSE = `<${DSML}DSML${DSML}/tool_calls>`;

// ─── DSML parse tests ───────────────────────────────────────────────────────

test("parseTextualToolCallCandidate detects complete DSML invoke block", () => {
  const text = `${DSML_TC_OPEN}
${DSML_INVOKE_OPEN} name="terminal">
${DSML_PARAM_OPEN} name="command" string="true">rg -l "descubrimiento" src${DSML_PARAM_CLOSE}
${DSML_PARAM_OPEN} name="cd" string="true">/Users/test${DSML_PARAM_CLOSE}
${DSML_INVOKE_CLOSE}
${DSML_TC_CLOSE}`;

  const result = parseTextualToolCallCandidate(text);
  assert.ok(result);
  assert.equal(result.kind, "complete");
  assert.equal(result.name, "terminal");
  assert.ok(result.args && typeof result.args === "object");
  assert.equal((result.args as Record<string, string>).command, 'rg -l "descubrimiento" src');
  assert.equal((result.args as Record<string, string>).cd, "/Users/test");
});

test("parseTextualToolCallCandidate returns partial for unclosed DSML invoke", () => {
  const text = `${DSML_TC_OPEN}
${DSML_INVOKE_OPEN} name="terminal">
${DSML_PARAM_OPEN} name="command" string="true">rg -l src`;

  const result = parseTextualToolCallCandidate(text);
  assert.ok(result);
  assert.equal(result.kind, "partial");
});

test("parseTextualToolCallCandidate returns partial for DSML tool_calls open only", () => {
  const text = DSML_TC_OPEN;
  const result = parseTextualToolCallCandidate(text);
  assert.ok(result);
  assert.equal(result.kind, "partial");
});

test("parseTextualToolCallCandidate returns null for plain text without DSML", () => {
  const result = parseTextualToolCallCandidate("Hello, world!");
  assert.equal(result, null);
});

test("parseTextualToolCallCandidate returns null for empty string", () => {
  assert.equal(parseTextualToolCallCandidate(""), null);
});

test("parseTextualToolCallCandidate handles multiple DSML parameters", () => {
  const text = `${DSML_INVOKE_OPEN} name="edit_file">
${DSML_PARAM_OPEN} name="path">/tmp/test.ts${DSML_PARAM_CLOSE}
${DSML_PARAM_OPEN} name="content">const x = 1;${DSML_PARAM_CLOSE}
${DSML_PARAM_OPEN} name="line">42${DSML_PARAM_CLOSE}
${DSML_INVOKE_CLOSE}`;

  const result = parseTextualToolCallCandidate(text);
  assert.ok(result);
  assert.equal(result.kind, "complete");
  assert.equal(result.name, "edit_file");
  const args = result.args as Record<string, string>;
  assert.equal(args.path, "/tmp/test.ts");
  assert.equal(args.content, "const x = 1;");
  assert.equal(args.line, "42");
});

test("parseTextualToolCallCandidate still handles [Tool call: ...] format", () => {
  const text = '[Tool call: terminal]\nArguments: {"command": "ls -la"}';
  const result = parseTextualToolCallCandidate(text);
  assert.ok(result);
  assert.equal(result.kind, "complete");
  assert.equal(result.name, "terminal");
  assert.deepEqual(result.args, { command: "ls -la" });
});

test("containsTextualToolCallMarker detects DSML markers", () => {
  assert.ok(containsTextualToolCallMarker(DSML_TC_OPEN));
  assert.ok(containsTextualToolCallMarker(`${DSML_INVOKE_OPEN} name="test">`));
  assert.ok(!containsTextualToolCallMarker("plain text"));
  assert.ok(!containsTextualToolCallMarker(""));
});

test("containsTextualToolCallMarker still detects [Tool call:] markers", () => {
  assert.ok(containsTextualToolCallMarker("[Tool call: terminal]"));
  assert.ok(containsTextualToolCallMarker("[Tool call: terminal]\nArguments: {}"));
  assert.ok(!containsTextualToolCallMarker("not a tool call"));
});

test("stripZeroWidth removes zero-width characters from strings", () => {
  assert.equal(stripZeroWidth("hello\u200Bworld"), "helloworld");
  assert.equal(stripZeroWidth("\uFEFFtest\u200D"), "test");
  assert.deepEqual(stripZeroWidth(["a\u200B", "b"]), ["a", "b"]);
  assert.deepEqual(stripZeroWidth({ key: "val\u200Cue" }), { key: "value" });
});

test("parseTextualToolCallCandidate handles DSML with text before the block", () => {
  const text = `Let me check the codebase first.
${DSML_TC_OPEN}
${DSML_INVOKE_OPEN} name="terminal">
${DSML_PARAM_OPEN} name="command">ls${DSML_PARAM_CLOSE}
${DSML_INVOKE_CLOSE}
${DSML_TC_CLOSE}`;

  const result = parseTextualToolCallCandidate(text);
  assert.ok(result);
  assert.equal(result.kind, "complete");
  assert.equal(result.name, "terminal");
  assert.equal((result.args as Record<string, string>).command, "ls");
});
