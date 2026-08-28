// DeepSeek-web-specific tool-call translation.
//
// chat.deepseek.com has no native function calling, so OmniRoute serializes the OpenAI
// `tools[]` into a prompt contract and parses the model's text reply back into OpenAI
// `tool_calls`. The canonical `webTools.ts` parser handles the well-behaved
// `<tool>{json}</tool>` / bare-JSON shapes used by most web-cookie providers, and it MUST
// stay untouched (it works for the others).
//
// DeepSeek, however, emits a much wider zoo of ad-hoc shapes:
//   <tool:todowrite>{json}</tool>            name in the tag suffix, body is the arguments
//   <tool_call>{id,type,params}</tool_call>  alternate key names (type → name, params → arguments)
//   <tool name="x">{json}</tool>             name in an attribute
//   <tool id="todo_write">{json}</tool>      tool name in the id attribute
//   <tool><tool ...>{json}</tool></tool>     doubled / nested wrappers
//   <tool id="1"><name>x</name><arguments>{json}</arguments></tool>   XML children
//   <tool:write><parameter name="content" content="...">             parameter style
//
// A single regex cannot robustly cover all of these (nesting + attributes + XML children),
// so this parser tokenizes the tool tags and walks them with a stack instead. It reuses the
// proven JSON-normalization / fuzzy-name-matching / range-stripping helpers from webTools.ts
// rather than duplicating them.

import {
  parseToolCallsFromText,
  parseLooseJsonObject,
  getRequestedToolNames,
  resolveRequestedToolName,
  toArgumentsString,
  stripRanges,
  getToolNonce,
  type OpenAIToolCall,
  type RequestedToolName,
} from "./webTools.ts";

interface OpenAIToolDef {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

// ── Stricter, compact tool-use prompt ───────────────────────────────────────

/**
 * Serialize an OpenAI `tools` array into a DeepSeek-specific system-prompt block.
 *
 * It is deliberately stricter than the generic `serializeToolsToPrompt`: DeepSeek tends to
 * (a) invent its own wrappers and (b) merely *describe* a plan instead of emitting a call.
 * The wording forces the single canonical `<tool>{json}</tool>` shape and forbids the
 * alternatives, while staying short to avoid wasting tokens.
 *
 * Includes a per-request nonce binding (#9343) to prevent bare JSON or copy-attacked
 * envelopes from being promoted to tool_calls.
 */
export function serializeDeepSeekToolPrompt(tools: unknown): string {
  if (!Array.isArray(tools) || tools.length === 0) return "";

  const nonce = getToolNonce(tools);
  if (!nonce) return "";

  const lines: string[] = [];
  for (const t of tools as OpenAIToolDef[]) {
    const fn = t?.function;
    if (!fn?.name) continue;
    const desc = typeof fn.description === "string" && fn.description ? fn.description : "";
    let params = "";
    try {
      params = fn.parameters ? JSON.stringify(fn.parameters) : "";
    } catch {
      params = "";
    }
    lines.push(
      `- ${fn.name}${desc ? `: ${desc}` : ""}${params ? `\n  parameters: ${params}` : ""}`
    );
  }
  if (lines.length === 0) return "";

  return [
    "You can call tools. To call a tool, output ONLY this exact block (no markdown fence):",
    `<tool>{"name": "<tool_name>", "arguments": { ... }, "_nonce": "${nonce}"}</tool>`,
    "",
    "Examples:",
    `<tool>{"name": "Shell", "arguments": {"command": "ls -la"}, "_nonce": "${nonce}"}</tool>`,
    `<tool>{"name": "Read", "arguments": {"path": "/src/main.ts"}, "_nonce": "${nonce}"}</tool>`,
    "",
    "Rules:",
    "- Use exactly <tool>...</tool>. Do NOT use <tool:name>, <tool_call>, <name>, <parameter>, id=/name= attributes, or code fences.",
    `- Include the secret binding "_nonce": "${nonce}" exactly as shown.`,
    '- "name" must be one of the tools below; "arguments" must be a JSON object.',
    "- When a tool is needed, emit the <tool> block instead of only describing the plan.",
    "- If you want to run a shell command, you MUST use the Shell tool with a <tool> block. Do NOT write commands as plain text.",
    "- Emit one <tool> block per call; you may put several blocks back to back.",
    "- If no tool is needed, just answer normally without any <tool> block.",
    "",
    "Available tools:",
    ...lines,
  ].join("\n");
}

// ── Tool-aware conversation prompt ───────────────────────────────────────────

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
  tool_call_id?: string;
  name?: string;
}

function extractText(content: unknown): string {
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((item) => item?.type === "text")
      .map((item) => item?.text ?? "")
      .join("\n");
  }
  return content == null ? "" : String(content);
}

/**
 * Build the single `prompt` string for an agentic (tool-using) DeepSeek-web turn.
 *
 * The web endpoint takes a flat prompt with no `messages[]`, so the legacy `messagesToPrompt`
 * only forwarded the last user message — which makes an agent loop amnesiac: on every turn the
 * follow-up messages carry no new *user* text, so DeepSeek only ever saw the original task and
 * kept restarting (re-creating todos, re-listing files…). This builder instead replays the WHOLE
 * trajectory — including the assistant's prior `<tool>` calls and each `role:"tool"` result — so
 * the model continues from where it left off instead of starting over.
 */
export function buildToolConversationPrompt(
  messages: ChatMessage[],
  toolSystemPrompt: string
): string {
  const systemParts: string[] = [];
  if (toolSystemPrompt) systemParts.push(toolSystemPrompt);

  const lines: string[] = [];
  const callNameById = new Map<string, string>();
  let sawToolActivity = false;

  // LEV fork: DeepSeek's web API has a limited input token budget (~64K tokens).
  // Cursor agentic sessions replay the entire trajectory including large tool
  // results (file contents, grep output, etc.). Without truncation, the prompt
  // exceeds DeepSeek's limit and the API returns an empty response
  // (content: null, completion_tokens: 0), killing the agent loop.
  const MAX_TOOL_RESULT_LEN = 4_000;
  const MAX_PROMPT_LEN = 120_000; // ~30K tokens, conservative for DeepSeek web

  const truncateToolResult = (text: string): string => {
    if (text.length <= MAX_TOOL_RESULT_LEN) return text;
    return (
      text.slice(0, MAX_TOOL_RESULT_LEN) +
      `\n[...tool result truncated, ${text.length - MAX_TOOL_RESULT_LEN} chars omitted...]`
    );
  };

  for (const m of messages) {
    if (m.role === "system") {
      const t = extractText(m.content).trim();
      if (t) systemParts.push(t);
    } else if (m.role === "user") {
      const t = extractText(m.content).trim();
      if (t) lines.push(`User: ${t}`);
    } else if (m.role === "assistant") {
      // LEV fork: Strip tool artifacts from assistant text before embedding
      // in the conversation prompt. Leftover <tool>, <tool_call>, <tool_calls> tags
      // from previous turns confuse DeepSeek-web and cause it to emit
      // malformed responses or restart the task from scratch.
      const rawText = extractText(m.content).trim();
      const t = stripToolArtifacts(rawText);
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const parts: string[] = [];
      if (t) parts.push(t);
      for (const c of calls) {
        const name = typeof c?.function?.name === "string" ? c.function.name : "";
        // LEV fork: Skip tool calls with unresolvable names — embedding bogus
        // <tool> blocks with unknown tool names confuses the model.
        if (!name) continue;
        const rawArgs = c?.function?.arguments;
        // LEV fork: validate arguments JSON before embedding in the <tool> block.
        // Malformed arguments (e.g., truncated JSON from a previous turn) produce
        // invalid <tool> blocks that confuse DeepSeek-web and cause it to return
        // empty responses (content: null, completion_tokens: 0).
        let args = "{}";
        if (typeof rawArgs === "string" && rawArgs) {
          try {
            JSON.parse(rawArgs);
            args = rawArgs;
          } catch {
            // Arguments are not valid JSON — use empty object instead of
            // embedding malformed JSON that would confuse the model.
            args = "{}";
          }
        } else if (rawArgs && typeof rawArgs === "object") {
          try {
            args = JSON.stringify(rawArgs);
          } catch {
            args = "{}";
          }
        }
        if (c?.id) callNameById.set(c.id, name);
        parts.push(`<tool>{"name": ${JSON.stringify(name)}, "arguments": ${args}}</tool>`);
        sawToolActivity = true;
      }
      if (parts.length) lines.push(`Assistant: ${parts.join("\n")}`);
    } else if (m.role === "tool") {
      const t = extractText(m.content).trim();
      const name = (m.tool_call_id && callNameById.get(m.tool_call_id)) || m.name || "tool";
      // LEV fork: Truncate large tool results to prevent the total prompt from
      // exceeding DeepSeek's input token limit, which causes empty responses.
      const truncated = truncateToolResult(t || "(no output)");
      lines.push(`Tool result (${name}): ${truncated}`);
      sawToolActivity = true;
    }
  }

  const parts: string[] = [];
  if (systemParts.length) parts.push(systemParts.join("\n\n"));
  if (lines.length) parts.push(lines.join("\n\n"));
  if (sawToolActivity) {
    // Anchor the model to the work already done so it advances instead of repeating it.
    parts.push(
      "Continue the task using the tool results above. Do NOT repeat tool calls that already " +
        "succeeded; perform the next step or give the final answer."
    );
  }

  let result = parts.join("\n\n").replace(/!\[.*?\]\(.*?\)/g, "");

  // LEV fork: If the total prompt still exceeds the limit, drop older turns
  // from the beginning of the conversation (keep system prompt + most recent
  // turns). This preserves the current task context while shedding old tool
  // results that are less relevant.
  if (result.length > MAX_PROMPT_LEN) {
    const systemSection = systemParts.length ? systemParts.join("\n\n") : "";
    const continuationHint = sawToolActivity
      ? "Continue the task using the tool results above. Do NOT repeat tool calls that already succeeded; perform the next step or give the final answer."
      : "";
    // Keep the last N lines that fit within the budget
    const budget = MAX_PROMPT_LEN - systemSection.length - continuationHint.length - 200;
    const allLines = lines.join("\n\n");
    if (allLines.length > budget) {
      const keptLines = allLines.slice(-budget);
      result = [systemSection, keptLines, continuationHint]
        .filter(Boolean)
        .join("\n\n")
        .replace(/!\[.*?\]\(.*?\)/g, "");
    }
  }

  return result;
}

// ── Tag tokenizer ────────────────────────────────────────────────────────────

interface TagToken {
  start: number;
  end: number;
  closing: boolean;
  suffix: string; // tool name after ':' in the tag (e.g. `<tool:bash>` → "bash")
  attrs: string; // raw attribute text inside the tag
}

// Matches an opening/closing <tool .../> or <tool_call .../> tag, optionally with a `:name`
// suffix and an attribute list. `tool_call` is listed first so it wins the alternation.
// LEV fork: also match <tool_calls> (plural) which DeepSeek sometimes emits
// instead of <tool_call>. The "s" variant is treated identically.
const TAG_TOKEN_RE = /<(\/?)(?:tool_calls|tool_call|tool)(:[A-Za-z0-9_.+-]+)?((?:\s[^>]*)?)\/?>/g;

function tokenizeToolTags(text: string): TagToken[] {
  const tokens: TagToken[] = [];
  let m: RegExpExecArray | null;
  TAG_TOKEN_RE.lastIndex = 0;
  while ((m = TAG_TOKEN_RE.exec(text)) !== null) {
    tokens.push({
      start: m.index,
      end: TAG_TOKEN_RE.lastIndex,
      closing: m[1] === "/",
      suffix: m[2] ? m[2].slice(1) : "",
      attrs: m[3] || "",
    });
  }
  return tokens;
}

interface ToolBlock {
  open: TagToken;
  close: TagToken;
  innerStart: number;
  innerEnd: number;
}

// Pair tags with a stack: every closing tag pairs with the nearest unmatched open. An open
// left unmatched at the end (e.g. the stray outer `<tool>` of a doubled wrapper, or a
// never-closed `<tool:write>` followed by `<parameter ...>`) gets a synthetic close at the end
// of the text so its body is still parsed; the doubled-wrapper outer is then dropped by the
// leaf filter.
function pairToolBlocks(tokens: TagToken[], textLen: number): ToolBlock[] {
  const blocks: ToolBlock[] = [];
  const stack: TagToken[] = [];
  for (const tok of tokens) {
    if (!tok.closing) {
      stack.push(tok);
      continue;
    }
    const open = stack.pop();
    if (!open) continue;
    blocks.push({ open, close: tok, innerStart: open.end, innerEnd: tok.start });
  }
  for (const open of stack) {
    const synthetic: TagToken = {
      start: textLen,
      end: textLen,
      closing: true,
      suffix: "",
      attrs: "",
    };
    blocks.push({ open, close: synthetic, innerStart: open.end, innerEnd: textLen });
  }
  return blocks;
}

// ── Attribute / XML-child helpers ────────────────────────────────────────────

/** Read an attribute value, tolerating backslash-escaped quotes inside the value. */
function getAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("|')`);
  const m = re.exec(attrs);
  if (!m) return null;
  const quote = m[1];
  let j = m.index + m[0].length;
  let out = "";
  while (j < attrs.length) {
    const ch = attrs[j];
    if (ch === "\\") {
      out += attrs[j + 1] ?? "";
      j += 2;
      continue;
    }
    if (ch === quote) break;
    out += ch;
    j += 1;
  }
  return out;
}

function getXmlChild(inner: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(inner);
  return m ? m[1].trim() : null;
}

// The body group is a tempered greedy token: `(?:(?!<parameter\b)[\s\S])*?` so an
// attribute-only `<parameter ...>` (no closing tag) cannot let the body matcher swallow a
// following `<parameter>...</parameter>` and drop that parameter.
const PARAM_TAG_RE = /<parameter\b([^>]*?)\/?>(?:((?:(?!<parameter\b)[\s\S])*?)<\/parameter>)?/gi;

/** Collect `<parameter name="x" content="y">` / `<parameter name="x">y</parameter>` into an object. */
function buildArgsFromParameters(inner: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let found = false;
  let m: RegExpExecArray | null;
  PARAM_TAG_RE.lastIndex = 0;
  while ((m = PARAM_TAG_RE.exec(inner)) !== null) {
    const attrs = m[1] || "";
    const body = m[2];
    const name = getAttr(attrs, "name");
    if (!name) continue;
    const value = getAttr(attrs, "content") ?? (typeof body === "string" ? body.trim() : "");
    out[name] = value;
    found = true;
  }
  return found ? out : null;
}

// ── Single-block extraction ──────────────────────────────────────────────────

interface ExtractedCall {
  name: string;
  arguments: string;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Build a map of tool name → set of parameter property keys from the requested tools array.
 * Used by the nameless-block fallback to do conservative schema-based name resolution.
 */
function buildSchemaParamMap(requestedTools: unknown): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  if (!Array.isArray(requestedTools)) return map;
  for (const tool of requestedTools as OpenAIToolDef[]) {
    const fn = tool?.function;
    if (!fn?.name) continue;
    const params = fn.parameters as Record<string, unknown> | undefined;
    const props = params?.properties;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      map.set(fn.name, new Set(Object.keys(props as Record<string, unknown>)));
    } else {
      map.set(fn.name, new Set());
    }
  }
  return map;
}

/**
 * Turn one tool block (tag name + inner text) into a name + JSON-string arguments.
 * Returns null when no plausible tool name can be recovered.
 */
function extractCall(
  tagName: string,
  innerRaw: string,
  requested: RequestedToolName[],
  schemaMap?: Map<string, Set<string>>
): ExtractedCall | null {
  const inner = innerRaw.trim();

  const nameChild = getXmlChild(inner, "name");
  const argsChild = getXmlChild(inner, "arguments") ?? getXmlChild(inner, "parameters");
  const paramObj = argsChild ? null : buildArgsFromParameters(inner);
  const hasXmlChildren = !!nameChild || !!argsChild || !!paramObj;

  const json = hasXmlChildren ? null : parseLooseJsonObject(inner);
  const jsonName = json ? (asString(json.name) ?? asString(json.type)) : null;

  const childResolved = nameChild ? resolveRequestedToolName(nameChild, requested) : null;
  const jsonResolved = jsonName ? resolveRequestedToolName(jsonName, requested) : null;
  const tagResolved = tagName ? resolveRequestedToolName(tagName, requested) : null;

  // Prefer a name that maps to a requested tool. The JSON body wins over the tag attribute
  // because DeepSeek sometimes emits a bogus tag name (e.g. name="skill", #3260).
  let name: string | null = null;
  let nameFromTag = false;
  const pick = (val: string | null, fromTag: boolean) => {
    if (!name && val) {
      name = val;
      nameFromTag = fromTag;
    }
  };
  pick(childResolved, false);
  pick(jsonResolved, false);
  pick(tagResolved, true);
  pick(nameChild, false);
  pick(jsonName, false);
  pick(tagName, true);

  // Shell-style `{ "command": "..." }` with no tag name: treat command as the tool name only
  // if it actually resolves to a requested tool (the value is otherwise the command itself).
  if (!name && !tagName && json) {
    const command = asString(json.command);
    const resolved = command ? resolveRequestedToolName(command, requested) : null;
    if (resolved) {
      name = resolved;
      nameFromTag = false;
    }
  }

  // Nameless-block fallback (#5154): when all explicit name-resolution paths fail but the
  // block has <parameter> children, try a conservative schema-based match. If exactly ONE
  // requested tool's parameter-schema keys are a superset of every extracted param name,
  // adopt that tool name. Zero matches or ambiguous (>1) → keep returning null to avoid
  // misattributing calls.
  if (!name && paramObj && schemaMap && schemaMap.size > 0) {
    const extractedKeys = Object.keys(paramObj);
    if (extractedKeys.length > 0) {
      const candidates: string[] = [];
      for (const [toolName, schemaKeys] of schemaMap) {
        if (schemaKeys.size > 0 && extractedKeys.every((k) => schemaKeys.has(k))) {
          candidates.push(toolName);
        }
      }
      if (candidates.length === 1) {
        name = candidates[0];
        nameFromTag = false;
      }
    }
  }

  if (!name) return null;

  let argsValue: unknown;
  if (argsChild) {
    argsValue = parseLooseJsonObject(argsChild) ?? argsChild;
  } else if (paramObj) {
    argsValue = paramObj;
  } else if (json) {
    if (json.arguments !== undefined) argsValue = json.arguments;
    else if (json.params !== undefined) argsValue = json.params;
    else if (nameFromTag) {
      // `<tool:bash>{"command": ...}` — the whole JSON object is the arguments payload.
      argsValue = json;
    } else {
      // Name came from the JSON body — the remaining keys are the arguments.
      const { name: _n, type: _t, id: _i, command: _c, arguments: _a, params: _p, ...rest } = json;
      argsValue = rest;
    }
  } else {
    argsValue = {};
  }

  return { name, arguments: toArgumentsString(argsValue) };
}

// ── Public parser ─────────────────────────────────────────────────────────────

// LEV fork: Parse the <tool_calls> wrapper format. DeepSeek-web emits several
// variants of tool-call wrappers that the standard <tool> block parser can't
// handle. This function deals with all of them:
//
// Variant 1 — child element tag = tool name, grandchildren = parameters:
//   <tool_calls>
//     <glob><glob_pattern>...</glob_pattern></glob>
//   </tool_calls>
//
// Variant 2 — DSML hybrid wrapper with <tool_name> child + JSON body:
//   <tool_calls>
//     <｜｜DSML｜｜ybridPLUGIN_tool_call xmlns="...">
//       <tool_name>Shell</tool_name>
//       {"command": "git status"}
//     </｜｜DSML｜｜ybridPLUGIN_tool_call>
//   </tool_calls>
//
// Variant 3 — direct <tool_name> + JSON body, no outer per-call wrapper:
//   <tool_calls>
//     <tool_name>Shell</tool_name>
//     {"command": "git status"}
//   </tool_calls>
//
// Returns parsed calls + the byte ranges of the wrapper block, or null if
// no tool calls were found.
// Handles both closed <tool_calls>...</tool_calls> and unclosed <tool_calls>...
const TOOL_CALLS_WRAPPER_RE = /<tool_calls\b[^>]*>([\s\S]*?)(?:<\/tool_calls>|$)/i;

// Match <tool_name>X</tool_name> to extract the tool name from DSML variants.
const TOOL_NAME_CHILD_RE = /<tool_name\b[^>]*>([\s\S]*?)<\/tool_name>/i;

function parseToolCallsWrapper(
  text: string,
  idSeed: string,
  requested: RequestedToolName[],
  schemaMap?: Map<string, Set<string>>
): { toolCalls: OpenAIToolCall[]; ranges: Array<{ start: number; end: number }> } | null {
  const wrapperMatch = TOOL_CALLS_WRAPPER_RE.exec(text);
  if (!wrapperMatch) return null;

  const wrapperStart = wrapperMatch.index;
  const wrapperEnd = wrapperMatch.index + wrapperMatch[0].length;
  const inner = wrapperMatch[1];

  const toolCalls: OpenAIToolCall[] = [];
  let idx = 0;

  // Strategy 1: Look for <tool_name> tags inside the wrapper (handles DSML
  // hybrid and direct tool_name variants). Each <tool_name> identifies a tool
  // call; the JSON arguments follow the closing </tool_name> tag.
  const toolNameRe = /<tool_name\b[^>]*>([\s\S]*?)<\/tool_name>/gi;
  let tnMatch: RegExpExecArray | null;
  const toolNamePositions: Array<{ name: string; argsStart: number }> = [];

  while ((tnMatch = toolNameRe.exec(inner)) !== null) {
    const rawName = tnMatch[1].trim();
    const resolved = resolveRequestedToolName(rawName, requested);
    const name = resolved || rawName;
    toolNamePositions.push({ name, argsStart: toolNameRe.lastIndex });
  }

  if (toolNamePositions.length > 0) {
    for (let i = 0; i < toolNamePositions.length; i++) {
      const { name, argsStart } = toolNamePositions[i];
      // Arguments go from after </tool_name> to the next <tool_name> or end of wrapper
      const argsEnd =
        i + 1 < toolNamePositions.length ? inner.indexOf("<tool_name", argsStart) : inner.length;
      const argsText = argsEnd > argsStart ? inner.slice(argsStart, argsEnd).trim() : "";

      let argsValue: unknown;
      const jsonParsed = parseLooseJsonObject(argsText);
      if (jsonParsed) {
        argsValue = jsonParsed;
      } else if (argsText) {
        // Try to extract child elements as parameters
        const paramRe = /<([A-Za-z_][A-Za-z0-9_.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
        const params: Record<string, unknown> = {};
        let pm: RegExpExecArray | null;
        let paramFound = false;
        while ((pm = paramRe.exec(argsText)) !== null) {
          params[pm[1]] = pm[2].trim();
          paramFound = true;
        }
        if (paramFound) {
          argsValue = params;
        } else if (schemaMap && schemaMap.has(name)) {
          const keys = schemaMap.get(name)!;
          if (keys.size === 1) {
            const [onlyKey] = keys;
            argsValue = { [onlyKey]: argsText };
          } else {
            const preferredKeys = [
              "command",
              "content",
              "query",
              "input",
              "pattern",
              "path",
              "code",
              "text",
            ];
            const matchKey = preferredKeys.find((k) => keys.has(k));
            argsValue = matchKey ? { [matchKey]: argsText } : { input: argsText };
          }
        } else {
          argsValue = { input: argsText };
        }
      } else {
        argsValue = {};
      }

      toolCalls.push({
        id: `${idSeed}_${idx++}`,
        type: "function",
        function: {
          name,
          arguments: safeArgsString(argsValue),
        },
      });
    }
  }

  // Strategy 2: If no <tool_name> tags found, try child elements where the
  // tag name IS the tool name (variant 1).
  if (toolCalls.length === 0) {
    const childElementRe = /<([A-Za-z_][A-Za-z0-9_.-]*)\b([^>]*?)>([\s\S]*?)<\/\1>/g;
    let m: RegExpExecArray | null;

    while ((m = childElementRe.exec(inner)) !== null) {
      const childTag = m[1];
      const childInner = m[3];

      // Skip if this child contains <tool_name> — already handled by strategy 1
      if (TOOL_NAME_CHILD_RE.test(childInner)) continue;

      const resolved = resolveRequestedToolName(childTag, requested);
      const name = resolved || childTag;

      const trimmedInner = childInner.trim();
      let argsValue: unknown;

      const jsonParsed = parseLooseJsonObject(trimmedInner);
      if (jsonParsed) {
        argsValue = jsonParsed;
      } else {
        const paramRe = /<([A-Za-z_][A-Za-z0-9_.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
        const params: Record<string, unknown> = {};
        let pm: RegExpExecArray | null;
        let paramFound = false;
        while ((pm = paramRe.exec(childInner)) !== null) {
          params[pm[1]] = pm[2].trim();
          paramFound = true;
        }
        if (paramFound) {
          argsValue = params;
        } else if (trimmedInner) {
          if (schemaMap && schemaMap.has(name)) {
            const keys = schemaMap.get(name)!;
            if (keys.size === 1) {
              const [onlyKey] = keys;
              argsValue = { [onlyKey]: trimmedInner };
            } else {
              const preferredKeys = [
                "command",
                "content",
                "query",
                "input",
                "pattern",
                "path",
                "code",
                "text",
              ];
              const matchKey = preferredKeys.find((k) => keys.has(k));
              argsValue = matchKey ? { [matchKey]: trimmedInner } : { input: trimmedInner };
            }
          } else {
            argsValue = { input: trimmedInner };
          }
        } else {
          argsValue = {};
        }
      }

      toolCalls.push({
        id: `${idSeed}_${idx++}`,
        type: "function",
        function: {
          name,
          arguments: safeArgsString(argsValue),
        },
      });
    }
  }

  if (toolCalls.length === 0) {
    // LEV fork: Even though no valid tool calls were found inside the wrapper,
    // we still strip the <tool_calls>...</tool_calls> tags so they don't
    // appear in the output text and confuse the client's parser. The inner
    // content is returned as plain text with no tool_calls.
    return { toolCalls: [], ranges: [{ start: wrapperStart, end: wrapperEnd }] };
  }
  return { toolCalls, ranges: [{ start: wrapperStart, end: wrapperEnd }] };
}

// LEV fork: Parse bare JSON tool calls (no XML tags at all).
// DeepSeek-web sometimes emits tool calls as bare JSON objects on their own,
// without any <tool> or <tool_calls> wrapper:
//   {"name": "Shell", "arguments": {"command": "git status"}}
//   {"name": "Read", "arguments": {"path": "/some/file.ts"}}
// Each JSON object with a "name" (or "command") field and an "arguments"
// (or "parameters") field is treated as a tool call.
const BARE_JSON_TOOL_RE =
  /\{[^{}]*"(?:name|command|tool_name|tool)"\s*:\s*"(?:[^"\\]|\\.)*"[^{}]*\}/g;

// LEV fork: Match markdown code fences wrapping tool call JSON:
//   ```tool
//   {"name": "Shell", "arguments": {"command": "git status"}}
//   ```
// Also matches ```tool_calls variant and unclosed fences.
const TOOL_CODE_FENCE_RE = /```tool(?:_calls)?\s*\n([\s\S]*?)(?:\n```|$)/gi;

// LEV fork: Strip any remaining empty ```tool or ```tool_calls code fences
// from the content. These are left behind when the JSON inside was extracted
// but the fence itself wasn't stripped. They confuse both the client and
// the model in subsequent turns.
const EMPTY_TOOL_FENCE_RE = /```tool(?:_calls)?\s*\n?```/gi;

// LEV fork: Safely serialize tool call arguments to a valid JSON string.
// If the args are a string that's not valid JSON (e.g., truncated from the
// model's response), wrap it in a {raw: ...} object instead of passing it
// through — malformed arguments crash the client and confuse the model in
// subsequent turns.
function safeArgsString(args: unknown): string {
  if (typeof args === "string") {
    try {
      JSON.parse(args);
      return args;
    } catch {
      return JSON.stringify({ raw: args });
    }
  }
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

function parseBareJsonToolCalls(
  text: string,
  idSeed: string,
  requested: RequestedToolName[]
): { content: string; toolCalls: OpenAIToolCall[] | null } {
  const toolCalls: OpenAIToolCall[] = [];
  const acceptedRanges: Array<{ start: number; end: number }> = [];

  // Strategy 1: Match markdown code fences wrapping tool call JSON.
  // This must run before bare JSON detection so the entire fence (not just
  // the JSON) gets stripped from the content.
  TOOL_CODE_FENCE_RE.lastIndex = 0;
  let fenceMatch: RegExpExecArray | null;
  let idx = 0;

  while ((fenceMatch = TOOL_CODE_FENCE_RE.exec(text)) !== null) {
    const fenceStart = fenceMatch.index;
    const fenceEnd = fenceMatch.index + fenceMatch[0].length;
    const jsonText = fenceMatch[1].trim();

    const parsed = parseLooseJsonObject(jsonText);
    if (!parsed) continue;

    const emittedName =
      (typeof parsed.name === "string" ? parsed.name : null) ??
      (typeof parsed.command === "string" ? parsed.command : null) ??
      (typeof parsed.tool_name === "string" ? parsed.tool_name : null) ??
      (typeof parsed.tool === "string" ? parsed.tool : null);
    if (!emittedName) continue;

    const name = resolveRequestedToolName(emittedName, requested) || emittedName;
    const args =
      parsed.arguments !== undefined
        ? parsed.arguments
        : parsed.parameters !== undefined
          ? parsed.parameters
          : parsed.args !== undefined
            ? parsed.args
            : {};

    toolCalls.push({
      id: `${idSeed}_${idx++}`,
      type: "function",
      function: {
        name,
        arguments: safeArgsString(args),
      },
    });
    acceptedRanges.push({ start: fenceStart, end: fenceEnd });
  }

  // Strategy 2: Match bare JSON objects (no code fence wrapper).
  BARE_JSON_TOOL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = BARE_JSON_TOOL_RE.exec(text)) !== null) {
    // Skip if this JSON is already inside a code fence that was matched
    if (acceptedRanges.some((r) => m!.index >= r.start && m!.index < r.end)) continue;

    const raw = m[0];
    const parsed = parseLooseJsonObject(raw);
    if (!parsed) continue;

    const emittedName =
      (typeof parsed.name === "string" ? parsed.name : null) ??
      (typeof parsed.command === "string" ? parsed.command : null) ??
      (typeof parsed.tool_name === "string" ? parsed.tool_name : null) ??
      (typeof parsed.tool === "string" ? parsed.tool : null);
    if (!emittedName) continue;

    const name = resolveRequestedToolName(emittedName, requested) || emittedName;
    const args =
      parsed.arguments !== undefined
        ? parsed.arguments
        : parsed.parameters !== undefined
          ? parsed.parameters
          : parsed.args !== undefined
            ? parsed.args
            : {};

    toolCalls.push({
      id: `${idSeed}_${idx++}`,
      type: "function",
      function: {
        name,
        arguments: safeArgsString(args),
      },
    });
    acceptedRanges.push({ start: m.index, end: m.index + raw.length });
  }

  if (toolCalls.length === 0) {
    // Even if no tool calls were found, strip any empty ```tool code fences
    // so they don't confuse the client or the model in subsequent turns.
    const stripped = text.replace(EMPTY_TOOL_FENCE_RE, "");
    if (stripped !== text) {
      return { content: stripped, toolCalls: null };
    }
    return { content: text, toolCalls: null };
  }
  let content = stripRanges(text, acceptedRanges);
  // Also strip any remaining empty tool code fences
  content = content.replace(EMPTY_TOOL_FENCE_RE, "");
  return { content, toolCalls };
}

// ── Artifact cleanup ─────────────────────────────────────────────────────────

/**
 * Strip ALL tool-related markup from text, regardless of whether tool calls
 * were extracted. This prevents wrapper artifacts (<tool>, tool_call, <tool_calls>,
 * code fences, <invoke> blocks) from poisoning conversation history or
 * reaching the IDE as visible content.
 */
const ARTIFACT_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // <tool>...</tool> blocks (with various tag suffixes)
  { re: /<\/?tool(?:_calls?|:[A-Za-z0-9_.+-]+)?\b[^>]*>/gi, replacement: "" },
  // tool_call.../tool_call blocks
  { re: /<\/?tool_call\b[^>]*>/gi, replacement: "" },
  // <invoke>...</invoke> blocks
  { re: /<\/?invoke\b[^>]*>/gi, replacement: "" },
  // <parameter>...</parameter> blocks
  { re: /<\/?parameter\b[^>]*>/gi, replacement: "" },
  // <tool_name>...</tool_name> blocks
  { re: /<\/?tool_name\b[^>]*>/gi, replacement: "" },
  // ```tool or ```tool_calls code fences (empty or not)
  { re: /```tool(?:_calls)?\s*\n?```/gi, replacement: "" },
];

export function stripToolArtifacts(text: string): string {
  let result = text;
  for (const { re, replacement } of ARTIFACT_PATTERNS) {
    result = result.replace(re, replacement);
  }
  // Clean up any leftover empty lines from stripped blocks
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Parse a DeepSeek-web text reply into OpenAI `tool_calls`. Returns the surrounding text with the recognized blocks stripped (so it can
 * still be streamed to the client) plus the parsed calls, or `null` when none are present.
 *
 * Falls back to the canonical `webTools.parseToolCallsFromText` for tag-free replies so that
 * bare-JSON and plain `<tool>` behavior stays identical to the shared implementation.
 */
export function parseDeepSeekToolCalls(
  text: string,
  idSeed = "call",
  requestedTools?: unknown
): { content: string; toolCalls: OpenAIToolCall[] | null } {
  if (typeof text !== "string" || text.length === 0) {
    return { content: text ?? "", toolCalls: null };
  }

  const tokens = tokenizeToolTags(text);
  if (tokens.length === 0) {
    // No DeepSeek-specific tags — try the canonical parser first (handles
    // <tool> and <tool_call> tags if present but missed by tokenizer), then fall
    // back to bare-JSON detection for unwrapped JSON tool calls.
    const canonical = parseToolCallsFromText(text, idSeed, requestedTools);
    if (canonical.toolCalls && canonical.toolCalls.length > 0) return canonical;
    const requested = getRequestedToolNames(requestedTools);
    return parseBareJsonToolCalls(text, idSeed, requested);
  }

  const requested = getRequestedToolNames(requestedTools);
  const schemaMap = buildSchemaParamMap(requestedTools);

  // LEV fork: check for <tool_calls> wrapper format first. This format has
  // child elements where each child tag IS the tool name and grandchildren
  // are parameters. The standard <tool> block parser can't handle this.
  const wrapperResult = parseToolCallsWrapper(text, idSeed, requested, schemaMap);
  if (wrapperResult) {
    const cleanedContent = stripRanges(text, wrapperResult.ranges).trim();
    return { content: cleanedContent, toolCalls: wrapperResult.toolCalls };
  }

  const blocks = pairToolBlocks(tokens, text.length);

  // Only extract from leaf blocks (no other block nested inside), so a doubled
  // `<tool><tool>...</tool></tool>` wrapper yields a single call from the inner block.
  const isLeaf = (b: ToolBlock) =>
    !blocks.some((o) => o !== b && o.open.start >= b.innerStart && o.close.end <= b.innerEnd);

  const toolCalls: OpenAIToolCall[] = [];
  const acceptedRanges: Array<{ start: number; end: number }> = [];
  const nonce = getToolNonce(requestedTools);

  for (const block of blocks.filter(isLeaf).sort((a, b) => a.open.start - b.open.start)) {
    const tagName =
      block.open.suffix ||
      getAttr(block.open.attrs, "name") ||
      getAttr(block.open.attrs, "id") ||
      "";
    const inner = text.slice(block.innerStart, block.innerEnd);
    const call = extractCall(tagName, inner, requested, schemaMap);
    if (!call) continue;

    // Nonce binding check (#9343): canonical JSON-body tool blocks (where the inner
    // text is JSON with a "name" field) that carry an explicit _nonce must match the
    // per-request binding. A wrong nonce means this is a copy-attack or hallucination.
    //
    // XML children (<parameter>, <name>, <arguments>) and tag-suffix blocks do not
    // have a JSON body, so the nonce check does not apply to them.
    // A missing _nonce is tolerated for backward compatibility.
    if (nonce) {
      const parsed = parseLooseJsonObject(inner);
      if (
        parsed &&
        typeof parsed.name === "string" &&
        parsed._nonce !== undefined &&
        parsed._nonce !== nonce
      )
        continue;
    }

    toolCalls.push({
      id: `${idSeed}_${toolCalls.length}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    });
    acceptedRanges.push({ start: block.open.start, end: block.close.end });
  }

  if (toolCalls.length === 0) {
    // Tags were present but none parsed (e.g. malformed or nonce-rejected).
    // Do NOT fall back to parseToolCallsFromText — that would re-process content
    // already seen by this parser and potentially promote rejected tagged output
    // to tool_calls. (#9343)
    // LEV fork: Strip tool artifacts from the content so leftover tags don't
    // poison conversation history or reach the IDE as visible content.
    return { content: stripToolArtifacts(text), toolCalls: null };
  }

  // Strip the accepted blocks plus any stray tool tags left outside them (the unmatched outer
  // `<tool>` of a doubled wrapper, leftover `</tool>` of a non-leaf wrapper, etc.).
  const within = (tok: TagToken) =>
    acceptedRanges.some((r) => tok.start >= r.start && tok.end <= r.end);
  const ranges = [
    ...acceptedRanges,
    ...tokens.filter((t) => !within(t)).map((t) => ({ start: t.start, end: t.end })),
  ];

  return { content: stripRanges(text, ranges), toolCalls };
}
