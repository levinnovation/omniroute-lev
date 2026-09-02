export type VirtualAliasFallback = readonly string[];

export const VIRTUAL_ALIASES: Record<string, VirtualAliasFallback> = {
  "lev.coding.default": [
    "claude/claude-sonnet-4-5",
    "codex/gpt-5.6-sol",
    "deepseek-web/deepseek-v4-pro",
  ],
  "lev.coding.fast": ["groq/llama-3.3-70b-versatile", "cline/z-ai/glm-5.2"],
  "lev.reasoning.default": ["claude/claude-opus-5", "codex/gpt-5.6-sol-max"],
  "lev.reasoning.fast": ["groq/qwen3-32b", "t3-web/claude-haiku-4"],
  "lev.chat.default": ["freellmapi/auto", "claude/claude-sonnet-4-5"],
  "lev.vision.default": ["gemini/gemini-2.5-flash", "antigravity/gemini-3.7-flash-low"],
};

const VIRTUAL_ALIAS_PREFIX = "lev.";

export function isVirtualAlias(model: string | null | undefined): boolean {
  return typeof model === "string" && model.startsWith(VIRTUAL_ALIAS_PREFIX);
}

export function resolveVirtualAlias(
  model: string,
  availableModels: ReadonlySet<string> | readonly string[]
): string {
  if (!isVirtualAlias(model)) return model;
  const fallbacks = VIRTUAL_ALIASES[model];
  if (!fallbacks || fallbacks.length === 0) return model;
  const set =
    availableModels instanceof Set ? (availableModels as Set<string>) : new Set(availableModels);
  for (const candidate of fallbacks) {
    if (set.has(candidate)) return candidate;
  }
  return fallbacks[0];
}
