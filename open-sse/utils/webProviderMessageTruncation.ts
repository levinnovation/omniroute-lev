/**
 * LEV fork: Pre-gate message truncation for web-cookie providers.
 *
 * OmniRoute's pre-flight context window check (`enforceOutputTokenBudget` in
 * chatCore.ts) rejects requests whose estimated input tokens exceed the
 * provider's context limit. For web-cookie providers like perplexity-web,
 * which have much smaller effective context windows (40K tokens vs 128K+
 * for API providers), large coding-agent requests (Cursor sends 280K+ token
 * system prompts with tool catalogs, repo context, agent transcripts) are
 * rejected before the executor's own truncation logic can run.
 *
 * This module trims the OpenAI-format `messages` array in-place so the
 * request fits within the provider's context window, preserving the most
 * important content in priority order:
 *   1. System prompt (truncated to a budget — keeps IDE identity + core instructions)
 *   2. Current user message (truncated if enormous)
 *   3. Most recent history (older history dropped first)
 *
 * The truncation is character-based (4 chars ≈ 1 token) which is consistent
 * with OmniRoute's own `estimateTokens` heuristic.
 */

const CHARS_PER_TOKEN = 4;

/** Providers that need pre-gate message truncation due to small effective context windows. */
const PRE_GATE_TRUNCATION_PROVIDERS = new Set(["perplexity-web"]);

/** Fraction of the context window reserved for output tokens. */
const OUTPUT_RESERVE_FRACTION = 0.15;

/** Maximum chars for the system prompt (keeps IDE identity + core instructions). */
const MAX_SYSTEM_CHARS = 12_000;

/** Maximum chars for the current user message. */
const MAX_CURRENT_MSG_CHARS = 20_000;

/**
 * Returns true if the provider needs pre-gate message truncation.
 */
export function needsPreGateTruncation(provider: string): boolean {
  return PRE_GATE_TRUNCATION_PROVIDERS.has(provider);
}

/**
 * Extract text content from an OpenAI message's content field (string or array).
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((c) => c.type === "text")
      .map((c) => String(c.text || ""))
      .join(" ");
  }
  return "";
}

/**
 * Set text content on an OpenAI message, preserving the original format
 * (string stays string, array stays array with a single text part).
 */
function setTextContent(msg: Record<string, unknown>, text: string): void {
  if (typeof msg.content === "string") {
    msg.content = text;
  } else if (Array.isArray(msg.content)) {
    // Replace array content with a single text part, dropping images/non-text
    // (web-cookie providers can't use images anyway).
    msg.content = text ? [{ type: "text", text }] : [];
  } else {
    msg.content = text;
  }
}

/**
 * Truncate a string to maxChars, appending a truncation marker if cut.
 */
function truncateString(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n[...truncated...]";
}

/**
 * Truncate the messages array in-place so the estimated token count fits
 * within the provider's context window.
 *
 * Strategy (in priority order):
 * 1. Truncate the system prompt to MAX_SYSTEM_CHARS
 * 2. Truncate the current (last) user message to MAX_CURRENT_MSG_CHARS
 * 3. Drop older history messages from the front until within budget
 * 4. If still over, truncate the current message further
 *
 * @param messages OpenAI-format messages array (modified in-place)
 * @param contextLimit Provider's context window in tokens
 * @returns The (possibly modified) messages array
 */
export function truncateMessagesForWebProvider(
  messages: Array<Record<string, unknown>>,
  contextLimit: number
): Array<Record<string, unknown>> {
  if (messages.length === 0) return messages;

  const outputReserve = Math.floor(contextLimit * OUTPUT_RESERVE_FRACTION);
  const inputBudget = Math.max(1, contextLimit - outputReserve);
  const budgetChars = inputBudget * CHARS_PER_TOKEN;

  // Phase 1: Truncate system messages.
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const content = extractTextContent(msg.content);
      if (content.length > MAX_SYSTEM_CHARS) {
        setTextContent(msg, truncateString(content, MAX_SYSTEM_CHARS));
      }
    }
  }

  // Phase 2: Truncate the last user message if it's enormous.
  const lastIdx = messages.length - 1;
  const lastMsg = messages[lastIdx];
  if (lastMsg && (lastMsg.role === "user" || lastMsg.role === "assistant")) {
    const content = extractTextContent(lastMsg.content);
    if (content.length > MAX_CURRENT_MSG_CHARS) {
      setTextContent(lastMsg, truncateString(content, MAX_CURRENT_MSG_CHARS));
    }
  }

  // Phase 3: Estimate total size; if within budget, done.
  let totalChars = messages.reduce((sum, m) => sum + extractTextContent(m.content).length, 0);

  if (totalChars <= budgetChars) return messages;

  // Phase 4: Drop older non-system messages from the front.
  // Keep system messages (they're already truncated) and the last message.
  const dropableIndices: number[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const role = messages[i].role;
    if (role !== "system" && role !== "developer") {
      dropableIndices.push(i);
    }
  }

  // Drop from the front (oldest first).
  const dropped = new Set<number>();
  for (const idx of dropableIndices) {
    if (totalChars <= budgetChars) break;
    totalChars -= extractTextContent(messages[idx].content).length;
    dropped.add(idx);
  }

  // Build filtered array, excluding dropped indices.
  const filtered = messages.filter((_, i) => !dropped.has(i));

  // Re-check: if still over budget, truncate the last message further.
  totalChars = filtered.reduce((sum, m) => sum + extractTextContent(m.content).length, 0);

  if (totalChars > budgetChars && filtered.length > 0) {
    const last = filtered[filtered.length - 1];
    const systemChars = filtered
      .filter((m) => m.role === "system" || m.role === "developer")
      .reduce((sum, m) => sum + extractTextContent(m.content).length, 0);
    const otherChars = totalChars - systemChars - extractTextContent(last.content).length;
    const remainingBudget = Math.max(1000, budgetChars - systemChars - otherChars);
    const lastContent = extractTextContent(last.content);
    if (lastContent.length > remainingBudget) {
      setTextContent(last, truncateString(lastContent, remainingBudget));
    }
  }

  return filtered;
}
