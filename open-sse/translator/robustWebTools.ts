/**
 * robustWebTools.ts — LEV fork: Shared robust tool-call handling for ALL
 * web-cookie providers.
 *
 * This module wraps the canonical `webTools.ts` and `deepseekWebTools.ts`
 * parsers with the production-grade recovery logic pioneered in
 * deepseek-web.ts:
 *
 *   1. Tool-call parsing from BOTH content AND reasoning_content (thinking
 *      models like deepseek-reasoner put <tool> blocks in reasoning).
 *   2. Narrated-intent detection — model says "Let me check X" but stops
 *      without emitting a tool block, killing the agent loop.
 *   3. Corrective retry — sends a minimal corrective prompt to force the
 *      model to emit the tool block.
 *   4. Grep-tool synthesis — if retry also fails, synthesize a Grep tool
 *      call from the narrated intent to keep the agent loop alive.
 *
 * All web-cookie providers should use `parseAndRecoverToolCalls()` instead
 * of calling `parseToolCallsFromText` or `parseDeepSeekToolCalls` directly.
 */

import {
  parseToolCallsFromText,
  buildToolAwareResult as canonicalBuildToolAwareResult,
  getRequestedToolNames,
  type OpenAIToolCall,
  type RequestedToolName,
} from "./webTools.ts";

import { parseDeepSeekToolCalls } from "./deepseekWebTools.ts";

// ── Types ────────────────────────────────────────────────────────────────

export interface ToolCallParseResult {
  content: string;
  reasoningContent: string;
  toolCalls: OpenAIToolCall[] | null;
}

export interface RobustToolCallOptions {
  /** The raw content text from the provider response */
  content: string;
  /** The raw reasoning/thinking content (if provider separates it) */
  reasoningContent?: string;
  /** ID seed for tool call IDs */
  idSeed?: string;
  /** The tools array from the client request (for name resolution) */
  requestedTools?: unknown;
  /** Whether to use the DeepSeek-specific parser (handles <tool:*> tags etc) */
  useDeepSeekParser?: boolean;
}

// ── Narrated-intent detection ─────────────────────────────────────────────

const NARRATED_INTENT_RE =
  /\b(let me|I'll|I will|I need to|let's|I want to|I'm going to|we'll|we will|we need to)\b.+\b(read|check|look|search|find|continue|see|inspect|examine|explore|run|execute|call|use|open|list|grep|glob|write|edit|create|delete|shell|terminal|debug|pull|fetch|get|update|set|configure|deploy|commit|push|install|build|test)\b/i;

export function looksLikeNarratedIntent(content: string): boolean {
  const text = content.trim();
  if (text.length < 10) return false;
  if (text.includes("<tool>")) return false;
  if (text.length <= 500) return NARRATED_INTENT_RE.test(text);
  const tail = text.slice(-400);
  return NARRATED_INTENT_RE.test(tail);
}

// ── Grep-tool synthesis ───────────────────────────────────────────────────

export function synthesizeGrepToolCall(
  lastUserText: string,
  requestedTools: unknown
): OpenAIToolCall | null {
  const tools = getRequestedToolNames(requestedTools);
  const hasGrep = tools.some((t) => t.original === "Grep" || t.original === "grep");
  if (!hasGrep || !lastUserText) return null;
  const pageMatch = /\/(\w+)\/?$/.exec(lastUserText);
  const pattern = pageMatch
    ? pageMatch[1]
    : lastUserText
        .replace(/[<>\[\]{}]/g, "")
        .split(/\s+/)
        .filter(
          (w) =>
            w.length > 3 &&
            !/^(the|this|that|with|from|have|your|into|page|table|header|glass|seems|broken|aligned|look|need|find|code|unified|understand|issue|alignment|not|properly|debug|crash|loop|service|logs|status|check|click|house|railway|agent|core|ecosystem|production|release|plan|phase|step|set|env|var|variables|backed|self|register|broken|fix|restart|connect|repo|github|test|rebase|branch|push|deploy|langfuse|trace|baseline|dashboard|widget|verify|approve|force|with|lease)$/i.test(
              w
            )
        )
        .slice(0, 3)
        .join("|");
  if (!pattern) return null;
  return {
    id: `call-${Date.now()}`,
    type: "function" as const,
    function: {
      name: "Grep",
      arguments: JSON.stringify({
        pattern,
        output_mode: "files_with_matches",
      }),
    },
  };
}

// ── Corrective retry prompt builder ───────────────────────────────────────

export function buildCorrectiveRetryPrompt(
  toolSystemPrompt: string,
  lastUserText: string,
  cleanedContent: string,
  nonce?: string
): string {
  const nonceStr = nonce ? `"_nonce": "${nonce}"` : `"_nonce": "..."`;
  return (
    toolSystemPrompt +
    "\n\n---\nPrevious task context (last user request):\n" +
    truncateText(lastUserText, 2_000) +
    '\n\n---\nIMPORTANT: Your previous response was: "' +
    cleanedContent.slice(0, 200) +
    '" — you narrated intent to use a tool but did NOT emit a <tool> block. ' +
    "You MUST emit the <tool> block NOW. Do not describe what you will do — " +
    `do it by outputting the <tool>{"name": ..., "arguments": ..., ${nonceStr}}</tool> block immediately. ` +
    "For example, to find relevant files, emit: " +
    `<tool>{"name": "Grep", "arguments": {"pattern": "reposicion", "output_mode": "files_with_matches"}, ${nonceStr}}</tool>`
  );
}

// ── Last user text extraction ─────────────────────────────────────────────

export function extractLastUserText(messages: Array<{ role: string; content: string }>): string {
  const lastUserMsg = messages.filter((m) => m.role === "user").pop();
  if (!lastUserMsg) return "";
  if (typeof lastUserMsg.content === "string") return lastUserMsg.content;
  if (Array.isArray(lastUserMsg.content)) {
    return (lastUserMsg.content as Array<{ type?: string; text?: string }>)
      .filter((p) => p?.type === "text")
      .map((p) => p?.text ?? "")
      .join("\n");
  }
  return "";
}

// ── Core: parse tool calls from content + reasoning ───────────────────────

/**
 * Parse tool calls from both content and reasoning_content. Thinking models
 * (deepseek-reasoner, qwen-reasoning, etc.) often put <tool> blocks in
 * reasoning_content instead of content.
 */
export function parseAndRecoverToolCalls(opts: RobustToolCallOptions): ToolCallParseResult {
  const {
    content,
    reasoningContent = "",
    idSeed = `call-${Date.now()}`,
    requestedTools,
    useDeepSeekParser = true,
  } = opts;

  const parser = useDeepSeekParser ? parseDeepSeekToolCalls : parseToolCallsFromText;

  // Parse content first
  let result = parser(content, idSeed, requestedTools);
  let cleanedContent = result.content;
  let toolCalls = result.toolCalls;

  // If no tool calls in content, check reasoning_content
  if ((!toolCalls || toolCalls.length === 0) && reasoningContent) {
    const reasoningResult = parser(reasoningContent, idSeed, requestedTools);
    if (reasoningResult.toolCalls && reasoningResult.toolCalls.length > 0) {
      toolCalls = reasoningResult.toolCalls;
      // Strip the tool block from reasoning so it doesn't appear in output
      const strippedReasoning = reasoningResult.content;
      return {
        content: "",
        reasoningContent: strippedReasoning,
        toolCalls,
      };
    }
  }

  return {
    content: cleanedContent,
    reasoningContent,
    toolCalls,
  };
}

// ── Helper: truncate text ─────────────────────────────────────────────────

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n[...truncated...]";
}

// ── Helper: check if narrated-intent recovery should run ──────────────────

export function shouldRunNarratedIntentRecovery(
  toolCalls: OpenAIToolCall[] | null,
  content: string
): boolean {
  return (!toolCalls || toolCalls.length === 0) && !!content && looksLikeNarratedIntent(content);
}

// ── Helper: apply Grep synthesis fallback ─────────────────────────────────

export function applyGrepSynthesisFallback(
  toolCalls: OpenAIToolCall[] | null,
  lastUserText: string,
  requestedTools: unknown
): { toolCalls: OpenAIToolCall[] | null; content: string } {
  if (!toolCalls || toolCalls.length === 0) {
    const synthCall = synthesizeGrepToolCall(lastUserText, requestedTools);
    if (synthCall) {
      return { toolCalls: [synthCall], content: "" };
    }
  }
  return { toolCalls, content: "" };
}

// ── Re-export buildToolAwareResult for convenience ────────────────────────

export { canonicalBuildToolAwareResult };

// ── Drop-in replacement for webTools.buildToolAwareResult ─────────────────
//
// Same signature as webTools.buildToolAwareResult but with optional
// reasoningContent and narrated-intent recovery. Web providers should
// migrate to this function instead of the canonical one.
//
// Usage:
//   import { buildRobustToolAwareResult } from "../translator/robustWebTools.ts";
//   const { content, toolCalls, finishReason } = buildRobustToolAwareResult(
//     rawContent, requestedTools, "provider-id", { reasoningContent }
//   );

export interface RobustToolAwareResult {
  content: string;
  toolCalls: OpenAIToolCall[] | null;
  finishReason: string;
  reasoningContent?: string;
}

export function buildRobustToolAwareResult(
  rawContent: string,
  requestedTools: unknown,
  idSeed = "call",
  opts?: {
    reasoningContent?: string;
    useDeepSeekParser?: boolean;
  }
): RobustToolAwareResult {
  const reasoningContent = opts?.reasoningContent ?? "";
  const useDeepSeekParser = opts?.useDeepSeekParser ?? true;

  const parseResult = parseAndRecoverToolCalls({
    content: rawContent,
    reasoningContent,
    idSeed: `${idSeed}-${Date.now()}`,
    requestedTools,
    useDeepSeekParser,
  });

  const hasCalls = !!parseResult.toolCalls && parseResult.toolCalls.length > 0;
  return {
    content: parseResult.content,
    toolCalls: parseResult.toolCalls,
    finishReason: hasCalls ? "tool_calls" : "stop",
    reasoningContent: parseResult.reasoningContent,
  };
}

// ── Re-export types ───────────────────────────────────────────────────────

export type { OpenAIToolCall, RequestedToolName };
