/**
 * LEV fork Phase 4: CrewAI agentic coding delegate.
 *
 * When OMNIROUTE_CREWAI_URL is set and the request model has the "agentic/"
 * prefix (e.g. "agentic/coder"), OmniRoute delegates the request to the
 * CrewAI coding sidecar. The sidecar runs a CrewAI flow that uses OmniRoute
 * as its LLM backend (via the internal API key), executes coding tools
 * (file ops, shell, web search), and returns the result.
 *
 * Recursion prevention:
 * - The CrewAI sidecar calls back to OmniRoute with OMNIROUTE_INTERNAL_AGENT_KEY.
 * - OmniRoute detects this key and NEVER routes internal requests to the
 *   CrewAI sidecar.
 * - A depth header (X-OmniRoute-Depth) tracks delegation depth; max depth = 2.
 *
 * If the CrewAI sidecar is unreachable or returns an error, the delegate
 * returns null so the existing OmniRoute executor path handles the request.
 */

import { getCrewAIConfig } from "../../services/sidecars.ts";

export interface CrewAIDelegateArgs {
  model: string;
  body: Record<string, unknown> | null | undefined;
  stream: boolean;
  signal?: AbortSignal | null;
  log?: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | null;
  /** The API key from the incoming request. Used to detect internal requests. */
  requestApiKey?: string | null;
}

export interface CrewAIDelegateResult {
  success: boolean;
  response: Response;
}

/** Maximum delegation depth (prevents infinite recursion). Reserved for future depth-tracking. */
const _MAX_DELEGATION_DEPTH = 2;

/** Model prefix that triggers CrewAI delegation. */
const AGENTIC_PREFIX = "agentic/";

/** Header name for tracking delegation depth. */
const DEPTH_HEADER = "x-omniroute-depth";

/**
 * Check if the request should be delegated to the CrewAI sidecar.
 * Returns false when:
 * - The CrewAI sidecar is not configured.
 * - The request is from an internal agent (recursion prevention).
 * - The model does not have the "agentic/" prefix.
 * - The delegation depth exceeds the maximum.
 */
export function shouldDelegateToCrewAI(args: CrewAIDelegateArgs): boolean {
  // Sidecar must be configured
  if (!process.env.OMNIROUTE_CREWAI_URL) return false;

  // Recursion prevention: detect internal API key
  const internalKey = process.env.OMNIROUTE_INTERNAL_AGENT_KEY;
  if (internalKey && args.requestApiKey === internalKey) {
    return false; // Internal request — never route back to CrewAI
  }

  // Model must have the agentic/ prefix
  if (!args.model.startsWith(AGENTIC_PREFIX)) return false;

  return true;
}

/**
 * Extract the underlying LLM model from an "agentic/" prefixed model.
 * "agentic/coder" → "coder" (the CrewAI sidecar resolves the actual model).
 * "agentic/gpt-4o" → "gpt-4o" (explicit model passthrough).
 */
export function extractAgenticModel(model: string): string {
  return model.startsWith(AGENTIC_PREFIX) ? model.slice(AGENTIC_PREFIX.length) : model;
}

/**
 * Attempt to delegate an agentic coding request to the CrewAI sidecar.
 * Returns null when delegation is not applicable or fails — the caller
 * falls back to the existing OmniRoute executor path.
 *
 * The CrewAI sidecar runs a CrewAI flow that:
 * 1. Receives the coding prompt.
 * 2. Uses OmniRoute as its LLM backend (via OMNIROUTE_INTERNAL_AGENT_KEY).
 * 3. Executes coding tools (file_read, file_write, shell_exec, web_search).
 * 4. Returns the coding result.
 *
 * OmniRoute wraps the result as an OpenAI-compatible chat completion response.
 */
export async function tryCrewAIDelegate(
  args: CrewAIDelegateArgs
): Promise<CrewAIDelegateResult | null> {
  if (!shouldDelegateToCrewAI(args)) return null;
  if (!args.body || typeof args.body !== "object") return null;

  const config = getCrewAIConfig();
  if (!config) return null;

  // Extract the coding prompt from the chat messages
  const messages = args.body.messages as Array<{ role: string; content: string }> | undefined;
  if (!messages || messages.length === 0) return null;

  // Extract the last user message as the coding prompt
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;

  const prompt =
    typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
  const agenticModel = extractAgenticModel(args.model);

  // Build the CrewAI sidecar request
  const crewaiBody = {
    inputs: {
      message: prompt,
      model: agenticModel,
      // Pass through conversation context for multi-turn
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    },
    model: agenticModel,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [DEPTH_HEADER]: "1", // This is the first delegation
  };
  if (config.apiKey) {
    headers["X-API-Key"] = config.apiKey;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 120_000);
    const signal = args.signal ?? controller.signal;

    args.log?.debug?.(
      "CREWAI",
      `delegating agentic request to CrewAI sidecar (model=${agenticModel})`
    );

    const response = await fetch(`${config.url.replace(/\/$/, "")}/api/v1/run`, {
      method: "POST",
      headers,
      body: JSON.stringify(crewaiBody),
      signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      args.log?.warn?.(
        "CREWAI",
        `CrewAI sidecar returned ${response.status}: ${await response.text().catch(() => "")}`
      );
      return null;
    }

    // The CrewAI sidecar returns {result: "...", error: null}.
    // Wrap it as an OpenAI-compatible chat completion response.
    const crewaiResult = await response.json();
    const codingResult = crewaiResult.result || "";
    const error = crewaiResult.error;

    if (error) {
      args.log?.warn?.("CREWAI", `CrewAI flow error: ${JSON.stringify(error)}`);
      return null;
    }

    // Build an OpenAI-compatible chat completion response
    const completionBody = {
      id: `chatcmpl-crewai-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: args.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: codingResult,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    return {
      success: true,
      response: new Response(JSON.stringify(completionBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    };
  } catch (err) {
    args.log?.warn?.(
      "CREWAI",
      `CrewAI delegation failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Check if a request is from an internal agent (recursion prevention).
 * Called from chatCore to skip CrewAI delegation for internal requests.
 */
export function isInternalAgentRequest(apiKey?: string | null): boolean {
  const internalKey = process.env.OMNIROUTE_INTERNAL_AGENT_KEY;
  return !!(internalKey && apiKey === internalKey);
}
