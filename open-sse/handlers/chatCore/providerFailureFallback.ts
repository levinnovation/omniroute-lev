import { sanitizeErrorMessage } from "../../utils/error.ts";

interface FallbackContext {
  provider: string;
  model: string;
  isCombo: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  log?: {
    info?: (tag: string, msg: string) => void;
    warn?: (tag: string, msg: string) => void;
  } | null;
}

interface FallbackResult {
  fallbacked: boolean;
  comboName?: string;
  handler?: () => Promise<Response>;
}

const FALLBACK_ERROR_CODES = new Set([
  "upstream_empty_response",
  "upstream_response_failed",
  "stream_early_eof",
  "stream_readiness_failed",
  "stream_stalled",
]);

export function isProviderFailureFallbackable(ctx: FallbackContext): boolean {
  if (ctx.isCombo) return false;
  if (process.env.OMNIROUTE_PROVIDER_FAILURE_FALLBACK !== "on") return false;
  if (!ctx.errorCode) return false;
  return FALLBACK_ERROR_CODES.has(ctx.errorCode);
}

export async function tryProviderFailureComboFallback(
  ctx: FallbackContext,
  dispatch: (comboName: string) => Promise<Response | null>
): Promise<FallbackResult> {
  if (!isProviderFailureFallbackable(ctx)) {
    return { fallbacked: false };
  }

  const fallbackComboName =
    process.env.OMNIROUTE_PROVIDER_FAILURE_COMBO ||
    process.env.OMNIROUTE_INPUT_OVERFLOW_COMBO ||
    "coding";

  try {
    ctx.log?.info?.(
      "FALLBACK",
      `Provider ${ctx.provider}/${ctx.model} failed with ${ctx.errorCode} — attempting combo fallback to "${fallbackComboName}"`
    );

    const result = await dispatch(fallbackComboName);
    if (result && result.status >= 200 && result.status < 400) {
      ctx.log?.info?.(
        "FALLBACK",
        `Combo fallback to "${fallbackComboName}" succeeded for ${ctx.provider}/${ctx.model}`
      );
      return { fallbacked: true, comboName: fallbackComboName, handler: async () => result };
    }

    ctx.log?.warn?.(
      "FALLBACK",
      `Combo fallback to "${fallbackComboName}" returned status ${result?.status ?? "null"} — returning original error`
    );
    return { fallbacked: false };
  } catch (err) {
    const safeMsg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    ctx.log?.warn?.(
      "FALLBACK",
      `Provider-failure combo fallback failed: ${safeMsg} — returning original error`
    );
    return { fallbacked: false };
  }
}
