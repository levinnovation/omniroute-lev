/**
 * LEV fork: Context fidelity gate for Mem0 context compaction.
 *
 * Before delegating context compaction to an external service (Mem0), we must
 * protect content that is unsafe to summarize or truncate:
 *   - Code blocks (```...```) — must remain verbatim
 *   - Tool call results — keep the last 5 turns verbatim
 *   - System prompts — must remain verbatim
 *
 * The gate replaces protected content with opaque markers before sending the
 * messages to Mem0, then re-inserts the original content after compaction.
 */

const PROTECTED_TURN_COUNT = 5;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const PROTECTED_MARKER_PREFIX = "[[OMNIROUTE_PROTECTED:";
const PROTECTED_MARKER_SUFFIX = "]]";

export interface ChatMessage {
  role: string;
  content: unknown;
}

export interface ProtectedBlock {
  id: string;
  original: string;
}

export interface ProtectResult {
  messages: ChatMessage[];
  protectedBlocks: ProtectedBlock[];
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((c) => c?.type === "text")
      .map((c) => String(c?.text ?? ""))
      .join("\n");
  }
  return "";
}

function setText(msg: ChatMessage, text: string): void {
  if (typeof msg.content === "string") {
    msg.content = text;
  } else if (Array.isArray(msg.content)) {
    msg.content = text ? [{ type: "text", text }] : [];
  } else {
    msg.content = text;
  }
}

/**
 * Returns true if compaction is safe for the given message list.
 * Compaction is unsafe when there are no messages, only a single system
 * prompt, or the conversation is too short to benefit.
 */
export function shouldCompact(messages: ChatMessage[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length < 4) return false;
  return true;
}

/**
 * Protect critical content from compaction:
 *   - Code blocks (```...```) are replaced with markers
 *   - The last 5 turns (tool results + surrounding user/assistant) are kept verbatim
 *   - System prompts are kept verbatim
 *
 * Returns the messages with protected content replaced by markers, plus the
 * list of protected blocks for later restoration.
 */
export function protectCriticalContent(messages: ChatMessage[]): ProtectResult {
  const protectedBlocks: ProtectedBlock[] = [];
  let counter = 0;

  const registerBlock = (original: string): string => {
    const id = `BLK_${counter++}`;
    protectedBlocks.push({ id, original });
    return `${PROTECTED_MARKER_PREFIX}${id}${PROTECTED_MARKER_SUFFIX}`;
  };

  const protectText = (text: string): string => {
    let result = text;
    result = result.replace(CODE_BLOCK_RE, (match) => registerBlock(match));
    return result;
  };

  const protectedRoles = new Set(["system", "developer"]);
  const lastTurnStart = Math.max(0, messages.length - PROTECTED_TURN_COUNT);

  const out: ChatMessage[] = messages.map((msg, idx) => {
    const cloned: ChatMessage = { ...msg };
    const text = extractText(cloned.content);
    if (!text) return cloned;

    if (protectedRoles.has(cloned.role)) {
      setText(cloned, registerBlock(text));
      return cloned;
    }

    if (idx >= lastTurnStart) {
      setText(cloned, registerBlock(text));
      return cloned;
    }

    const protectedText = protectText(text);
    if (protectedText !== text) {
      setText(cloned, protectedText);
    }
    return cloned;
  });

  return { messages: out, protectedBlocks };
}

/**
 * Re-insert protected content into compacted messages after Mem0 compaction.
 * Scans each message's text for markers and replaces them with the original
 * protected blocks.
 */
export function restoreProtectedContent(
  compactedMessages: ChatMessage[],
  protectedBlocks: ProtectedBlock[]
): ChatMessage[] {
  if (!protectedBlocks.length) return compactedMessages;
  const blockMap = new Map(protectedBlocks.map((b) => [b.id, b.original]));

  const restoreInText = (text: string): string => {
    return text.replace(
      new RegExp(
        `${escapeRegExp(PROTECTED_MARKER_PREFIX)}([A-Za-z0-9_]+)${escapeRegExp(PROTECTED_MARKER_SUFFIX)}`,
        "g"
      ),
      (_match, id: string) => blockMap.get(id) ?? _match
    );
  };

  return compactedMessages.map((msg) => {
    const text = extractText(msg.content);
    if (!text) return msg;
    const restored = restoreInText(text);
    if (restored === text) return msg;
    const cloned: ChatMessage = { ...msg };
    setText(cloned, restored);
    return cloned;
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
