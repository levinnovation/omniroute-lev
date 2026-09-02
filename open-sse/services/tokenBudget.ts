/**
 * LEV fork: Token-aware budget utilities for web-cookie providers.
 *
 * Replaces the character-based budget constants in web executors (e.g.
 * deepseek-web) with token-estimate-aware truncation. Uses a simple
 * heuristic: chars/4 for English/Latin text, chars/2 for CJK (Chinese,
 * Japanese, Korean) where each character tends to be a full token.
 *
 * Falls back to character-based constants when token estimation fails.
 */

const CJK_RANGE =
  /[\u1100-\u11FF\u2E80-\u2EFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA48F\uA490-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F]/g;

const CHARS_PER_TOKEN_LATIN = 4;
const CHARS_PER_TOKEN_CJK = 2;
const CJK_RATIO_THRESHOLD = 0.3;

export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  const cjkMatches = text.match(CJK_RANGE);
  const cjkChars = cjkMatches ? cjkMatches.length : 0;
  const latinChars = text.length - cjkChars;
  const cjkTokens = Math.ceil(cjkChars / CHARS_PER_TOKEN_CJK);
  const latinTokens = Math.ceil(latinChars / CHARS_PER_TOKEN_LATIN);
  return cjkTokens + latinTokens;
}

export function tokenAwareTruncate(text: string, maxTokens: number): string {
  if (!text || text.length === 0) return text;
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;

  const cjkMatches = text.match(CJK_RANGE);
  const cjkChars = cjkMatches ? cjkMatches.length : 0;
  const cjkRatio = text.length > 0 ? cjkChars / text.length : 0;
  const effectiveCharsPerToken =
    cjkRatio > CJK_RATIO_THRESHOLD ? CHARS_PER_TOKEN_CJK : CHARS_PER_TOKEN_LATIN;
  const charBudget = Math.max(1, maxTokens * effectiveCharsPerToken);

  if (text.length <= charBudget) return text;
  return text.slice(0, Math.floor(charBudget)) + "\n[...truncated...]";
}

export interface ProviderBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxSystemTokens: number;
  maxCurrentMessageTokens: number;
}

const DEFAULT_BUDGET: ProviderBudget = {
  maxInputTokens: 32_000,
  maxOutputTokens: 4_000,
  maxSystemTokens: 3_000,
  maxCurrentMessageTokens: 8_000,
};

const PROVIDER_BUDGETS: Record<string, Partial<ProviderBudget>> = {
  "deepseek-web": {
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    maxSystemTokens: 3_000,
    maxCurrentMessageTokens: 8_000,
  },
  "perplexity-web": {
    maxInputTokens: 36_000,
    maxOutputTokens: 4_000,
    maxSystemTokens: 3_000,
    maxCurrentMessageTokens: 10_000,
  },
  "grok-web": {
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    maxSystemTokens: 3_000,
    maxCurrentMessageTokens: 8_000,
  },
  "chatgpt-web": {
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    maxSystemTokens: 3_000,
    maxCurrentMessageTokens: 8_000,
  },
  "gemini-web": {
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    maxSystemTokens: 3_000,
    maxCurrentMessageTokens: 8_000,
  },
  "claude-web": {
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    maxSystemTokens: 3_000,
    maxCurrentMessageTokens: 8_000,
  },
  "zai-web": {
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    maxSystemTokens: 3_000,
    maxCurrentMessageTokens: 8_000,
  },
  "qwen-web": {
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    maxSystemTokens: 3_000,
    maxCurrentMessageTokens: 8_000,
  },
  "copilot-web": {
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    maxSystemTokens: 3_000,
    maxCurrentMessageTokens: 8_000,
  },
};

export function getBudgetForProvider(provider: string, model?: string | null): ProviderBudget {
  const providerBudget = PROVIDER_BUDGETS[provider];
  if (providerBudget) {
    return { ...DEFAULT_BUDGET, ...providerBudget };
  }
  const baseProvider = provider.replace(/-web$/, "");
  if (baseProvider !== provider && PROVIDER_BUDGETS[`${baseProvider}-web`]) {
    return { ...DEFAULT_BUDGET, ...PROVIDER_BUDGETS[`${baseProvider}-web`] };
  }
  void model;
  return { ...DEFAULT_BUDGET };
}

export const FALLBACK_MAX_SYSTEM_CHARS = 12_000;
export const FALLBACK_MAX_CURRENT_MSG_CHARS = 20_000;
