export function stripZeroWidth(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/[\u200B-\u200D\uFEFF]/g, "");
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripZeroWidth(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        stripZeroWidth(item),
      ])
    );
  }
  return value;
}

// ─── DSML tool-call detection ───────────────────────────────────────────────
//
// DeepSeek V4+ models emit tool calls as DSML (DeepSeek Markup Language) XML
// blocks instead of structured OpenAI tool_calls. The format is:
//
//   <｜DSML｜tool_calls>
//   <｜DSML｜invoke name="terminal">
//   <｜DSML｜parameter name="command" string="true">rg -l ...</｜DSML｜parameter>
//   <｜DSML｜parameter name="cd" string="true">/Users/...</｜DSML｜parameter>
//   </｜DSML｜invoke>
//   </｜DSML｜tool_calls>
//
// The ｜ character is U+FF5C (fullwidth vertical line). These blocks appear as
// text content in the SSE stream when the upstream provider doesn't parse them
// into structured tool_calls (e.g. cline/api.cline.bot for deepseek-v4-flash).
// We detect and convert them so agentic clients (Zed, Cursor, Cline) receive
// proper structured tool_calls instead of raw text.

// DSML marker — the fullwidth vertical line character used in DeepSeek's
// proprietary XML-like tool call format.
const DSML_MARKER = "\uff5c"; // ｜ (U+FF5C)
const DSML_OPEN = `<${DSML_MARKER}DSML${DSML_MARKER}`;
const DSML_INVOKE_RE = new RegExp(
  `<${DSML_MARKER}DSML${DSML_MARKER}invoke\\s+name="([^"]*)"\\s*>`,
  "i"
);
const DSML_INVOKE_CLOSE = `<${DSML_MARKER}DSML${DSML_MARKER}/invoke>`;
const DSML_PARAM_OPEN_RE = new RegExp(
  `<${DSML_MARKER}DSML${DSML_MARKER}parameter\\s+name="([^"]*)"\\s*(?:string="[^"]*")?\\s*>`,
  "i"
);
const DSML_PARAM_CLOSE = `<${DSML_MARKER}DSML${DSML_MARKER}/parameter>`;
const DSML_TOOL_CALLS_OPEN = `<${DSML_MARKER}DSML${DSML_MARKER}tool_calls>`;

function containsDsmlToolCallMarker(text: string): boolean {
  return text.includes(DSML_OPEN) || text.includes(DSML_TOOL_CALLS_OPEN);
}

/**
 * Parse a complete DSML invoke block into a tool call.
 * Returns null if the block is incomplete or malformed.
 */
function parseDsmlInvokeBlock(
  block: string
): { name: string; args: Record<string, string> } | null {
  const invokeMatch = block.match(DSML_INVOKE_RE);
  if (!invokeMatch) return null;
  const name = invokeMatch[1]?.trim();
  if (!name) return null;

  const closeIdx = block.indexOf(DSML_INVOKE_CLOSE, invokeMatch[0].length);
  if (closeIdx < 0) return null;

  const inner = block.slice(invokeMatch[0].length, closeIdx);
  const args: Record<string, string> = {};

  // Extract all <｜DSML｜parameter name="...">value</｜DSML｜parameter> children
  let searchIdx = 0;
  while (searchIdx < inner.length) {
    const paramOpenMatch = inner.slice(searchIdx).match(DSML_PARAM_OPEN_RE);
    if (!paramOpenMatch || paramOpenMatch.index === undefined) break;
    const paramStart = searchIdx + paramOpenMatch.index;
    const paramInnerStart = paramStart + paramOpenMatch[0].length;
    const paramCloseIdx = inner.indexOf(DSML_PARAM_CLOSE, paramInnerStart);
    if (paramCloseIdx < 0) break;
    const paramName = paramOpenMatch[1]?.trim();
    const paramValue = inner.slice(paramInnerStart, paramCloseIdx);
    if (paramName) {
      args[paramName] = paramValue;
    }
    searchIdx = paramCloseIdx + DSML_PARAM_CLOSE.length;
  }

  return { name, args };
}

/**
 * Parse DSML tool calls from text content.
 * Detects <｜DSML｜tool_calls>...<｜DSML｜invoke name="...">... blocks and
 * converts them to structured tool call candidates.
 */
function parseDsmlToolCallCandidate(
  text: string
): { kind: "complete"; name: string; args: unknown } | { kind: "partial" } | null {
  const toolCallsIdx = text.indexOf(DSML_TOOL_CALLS_OPEN);
  const invokeIdx = text.search(DSML_INVOKE_RE);

  // No DSML markers at all
  if (toolCallsIdx < 0 && invokeIdx < 0) return null;

  // Find the invoke block (may be inside a <｜DSML｜tool_calls> wrapper or standalone)
  const invokeSearchStart = toolCallsIdx >= 0 ? toolCallsIdx : 0;
  const invokeMatch = text.slice(invokeSearchStart).match(DSML_INVOKE_RE);
  if (!invokeMatch || invokeMatch.index === undefined) {
    // We have a tool_calls open tag but no invoke yet — partial
    if (toolCallsIdx >= 0) return { kind: "partial" };
    return null;
  }

  const invokeStart = invokeSearchStart + invokeMatch.index;
  const closeIdx = text.indexOf(DSML_INVOKE_CLOSE, invokeStart + invokeMatch[0].length);

  if (closeIdx < 0) {
    // Invoke block is not yet closed — partial
    return { kind: "partial" };
  }

  const block = text.slice(invokeStart, closeIdx + DSML_INVOKE_CLOSE.length);
  const parsed = parseDsmlInvokeBlock(block);
  if (!parsed) return { kind: "partial" };

  return { kind: "complete", name: parsed.name, args: parsed.args };
}

export function isValidToolCallHeaderPrefix(candidate: string): boolean {
  if (!candidate.startsWith("[Tool call:")) return false;

  const bracketIndex = candidate.indexOf("]");
  if (bracketIndex === -1) {
    const namePart = candidate.slice("[Tool call:".length);
    if (namePart.includes("\n") || namePart.includes("[")) return false;
    return true;
  }

  const namePart = candidate.slice("[Tool call:".length, bracketIndex);
  if (namePart.includes("\n") || namePart.trim().length === 0) return false;

  const afterBracket = candidate.slice(bracketIndex + 1);
  const leadingWhitespaceMatch = afterBracket.match(/^[\s\r\n]*/);
  const leadingWhitespace = leadingWhitespaceMatch ? leadingWhitespaceMatch[0] : "";
  const textAfterWhitespace = afterBracket.slice(leadingWhitespace.length);

  if (textAfterWhitespace.length === 0) {
    return true;
  }

  if (!leadingWhitespace.includes("\n")) {
    return false;
  }

  const expectedText = "Arguments:";
  if (expectedText.startsWith(textAfterWhitespace)) {
    return true;
  }

  if (textAfterWhitespace.startsWith(expectedText)) {
    return true;
  }

  return false;
}

export function parseTextualToolCallCandidate(
  text: unknown
): { kind: "complete"; name: string; args: unknown } | { kind: "partial" } | null {
  if (typeof text !== "string") return null;
  const normalized = text.replace(/[\u200B-\u200D\uFEFF]/g, "");

  // Try DSML format first (DeepSeek V4+ via cline/api providers)
  const dsmlResult = parseDsmlToolCallCandidate(normalized);
  if (dsmlResult) return dsmlResult;

  // Fall through to [Tool call: ...] format
  const toolCallIndex = normalized.lastIndexOf("[Tool call:");
  if (toolCallIndex < 0) {
    const lastParen = normalized.lastIndexOf("(");
    if (lastParen !== -1 && "(empty)[Tool call:".startsWith(normalized.slice(lastParen))) {
      return { kind: "partial" };
    }
    const lastBracket = normalized.lastIndexOf("[");
    if (lastBracket !== -1 && "[Tool call:".startsWith(normalized.slice(lastBracket))) {
      return { kind: "partial" };
    }
    return null;
  }
  const candidate = normalized.slice(toolCallIndex);
  if (!isValidToolCallHeaderPrefix(candidate)) {
    return null;
  }
  const headerMatch = candidate.match(/^\[Tool call:\s*([^\]\n]+)\]\s*\nArguments:\s*/);
  if (!headerMatch) return { kind: "partial" };
  const name = headerMatch[1]?.trim();
  const rawArgs = candidate.slice(headerMatch[0].length).trim();
  if (!name || !rawArgs) return { kind: "partial" };
  const decoders = [
    (value: string) => value,
    (value: string) => {
      if (value.startsWith('"') && value.endsWith('"')) {
        const decoded = JSON.parse(value);
        return typeof decoded === "string" ? decoded : value;
      }
      return value;
    },
  ];
  for (const decode of decoders) {
    try {
      const decoded = decode(rawArgs);
      const parsed = JSON.parse(decoded);
      return { kind: "complete", name, args: stripZeroWidth(parsed) };
    } catch {}
  }
  return { kind: "partial" };
}

export function containsTextualToolCallMarker(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const normalized = text.replace(/[\u200B-\u200D\uFEFF]/g, "");

  // DSML markers
  if (containsDsmlToolCallMarker(normalized)) return true;

  // [Tool call: ...] markers
  if (!normalized.includes("[Tool call:")) return false;
  if (normalized.includes("Arguments:")) return true;

  const trimmed = normalized.trim();
  return trimmed.startsWith("[Tool call:") || trimmed.startsWith("(empty)[Tool call:");
}
