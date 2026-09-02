/**
 * LEV fork: LiteLLM API-key delegate path.
 *
 * When OMNIROUTE_LITELLM_URL is set and OMNIROUTE_API_KEY_DELEGATE=litellm,
 * API-key provider requests (not web-cookie providers) are forwarded to the
 * LiteLLM sidecar as a thin proxy. The request body is passed through verbatim
 * and the response (streaming or non-streaming) is streamed back to the caller.
 *
 * If LiteLLM is unreachable or returns an error, the delegate returns null so
 * the existing OmniRoute executor path handles the request.
 */

import { getRegistryEntry } from "../../config/providerRegistry.ts";
import { getLiteLLMConfig } from "../../services/sidecars.ts";
import { CORS_HEADERS } from "../../utils/cors.ts";

export interface LiteLLMDelegateArgs {
  provider: string;
  body: Record<string, unknown> | null | undefined;
  stream: boolean;
  signal?: AbortSignal | null;
  log?: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | null;
  providerApiKey?: string | null;
}

export interface LiteLLMDelegateResult {
  success: boolean;
  response: Response;
}

function isLiteLLMDelegateEnabled(): boolean {
  return (
    process.env.OMNIROUTE_API_KEY_DELEGATE === "litellm" && !!process.env.OMNIROUTE_LITELLM_URL
  );
}

function isApiKeyProvider(provider: string): boolean {
  const entry = getRegistryEntry(provider);
  if (!entry) return false;
  return entry.authHeader !== "cookie";
}

/**
 * Attempt to delegate an API-key provider request to the LiteLLM sidecar.
 * Returns null when delegation is not applicable, disabled, or fails — the
 * caller falls back to the existing OmniRoute executor path.
 */
export async function tryLiteLLMDelegate(
  args: LiteLLMDelegateArgs
): Promise<LiteLLMDelegateResult | null> {
  if (!isLiteLLMDelegateEnabled()) return null;
  if (!isApiKeyProvider(args.provider)) return null;
  if (!args.body || typeof args.body !== "object") return null;

  const config = getLiteLLMConfig();
  if (!config) return null;

  const endpoint = `${config.url.replace(/\/$/, "")}/v1/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const forwardBody = {
    ...args.body,
    stream: args.stream,
    ...(args.providerApiKey ? { api_key: args.providerApiKey } : {}),
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 120000);
    const signal = args.signal ?? controller.signal;

    args.log?.debug?.("LITELLM", `delegating ${args.provider} request to LiteLLM`);

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(forwardBody),
      signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      args.log?.warn?.(
        "LITELLM",
        `LiteLLM returned ${response.status}, falling back to OmniRoute executor`
      );
      return null;
    }

    const responseHeaders = new Headers(CORS_HEADERS);
    responseHeaders.set("Content-Type", args.stream ? "text/event-stream" : "application/json");
    if (args.stream) {
      responseHeaders.set("Cache-Control", "no-cache");
      responseHeaders.set("Connection", "keep-alive");
    }

    return {
      success: true,
      response: new Response(response.body, { headers: responseHeaders }),
    };
  } catch (err) {
    args.log?.warn?.("LITELLM", `delegate failed, falling back to OmniRoute executor: ${err}`);
    return null;
  }
}
