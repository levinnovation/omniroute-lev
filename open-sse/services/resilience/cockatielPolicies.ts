// LEV fork: Cockatiel-based resilience policies for provider interactions.
//
// Replaces the custom circuit breaker with Cockatiel's composable policies:
//   - retry with exponential backoff + jitter
//   - circuit breaker with error-type predicates (404 ≠ 429 ≠ 502)
//   - timeout per provider
//   - bulkhead to prevent thundering-herd
//
// The existing circuitBreaker.ts and accountFallback.ts remain as the
// high-level orchestration layer; this module provides the low-level
// policy primitives that can be composed per-provider. It is a superset
// of the circuitBreaker.ts interface — existing callers keep working,
// new code can adopt getResiliencePolicy() for richer error classification.
//
// Usage:
//   const policy = createProviderPolicy("zai-web");
//   const result = await policy.execute(async () => { ... });
//
//   const policy = getResiliencePolicy("oauth");
//   const result = await policy.execute(async () => { ... });

import {
  retry,
  circuitBreaker,
  timeout,
  bulkhead,
  handleAll,
  handleWhen,
  ExponentialBackoff,
  type IPolicy,
  ConsecutiveBreaker,
} from "cockatiel";

export type ProviderType = "oauth" | "apikey" | "local";

export interface ProviderPolicyOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  maxConcurrent?: number;
  breakerThreshold?: number;
  breakerResetMs?: number;
}

/**
 * Extract an HTTP status code from an error-like object.
 * Returns undefined when no numeric status is present.
 */
function extractStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  if (error && typeof error === "object" && "statusCode" in error) {
    const status = (error as { statusCode: unknown }).statusCode;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/**
 * isRetryableError — transient failures worth retrying.
 * 408 (request timeout), 429 (rate limit), 500, 502, 503, 504 (server errors).
 */
export function isRetryableError(error: unknown): boolean {
  const status = extractStatus(error);
  if (status !== undefined) {
    return (
      status === 408 ||
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504
    );
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return true;
    if (error.name === "AbortError") return false;
    const msg = error.message || "";
    if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|network error/i.test(msg))
      return true;
  }
  return false;
}

/**
 * isTerminalError — credential/permission failures that won't recover on retry.
 * 401 (unauthorized), 403 (forbidden).
 */
export function isTerminalError(error: unknown): boolean {
  const status = extractStatus(error);
  return status === 401 || status === 403;
}

/**
 * isNotFoundError — model/resource not found. Model-specific issue, not a
 * whole-provider failure.
 */
export function isNotFoundError(error: unknown): boolean {
  return extractStatus(error) === 404;
}

/**
 * isRateLimitError — quota/rate-limit. Retryable but should trip the breaker
 * to back off upstream.
 */
export function isRateLimitError(error: unknown): boolean {
  return extractStatus(error) === 429;
}

/**
 * Error classification for circuit breaker decisions.
 * 404 (model not found) → don't trip breaker (model-specific issue)
 * 401 (auth) → don't trip breaker (credential issue)
 * 403 (forbidden) → don't trip breaker (permission issue)
 * 429 (rate limit) → trip breaker (quota issue)
 * 502/503/504 (server error) → trip breaker (transient)
 */
function shouldTripBreaker(error: unknown): boolean {
  if (isNotFoundError(error)) return false;
  if (isTerminalError(error)) return false;
  if (isRateLimitError(error)) return true;
  const status = extractStatus(error);
  if (status !== undefined && status >= 500) return true;
  if (error instanceof Error) {
    if (error.name === "AbortError") return false;
    if (error.name === "TimeoutError") return true;
  }
  return false;
}

/**
 * Create a composable resilience policy for a specific provider.
 * The policy combines retry, circuit breaker, timeout, and bulkhead.
 */
export function createProviderPolicy(
  _provider: string,
  options: ProviderPolicyOptions = {}
): IPolicy<Response> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    timeoutMs = 120000,
    maxConcurrent = 10,
    breakerThreshold = 5,
    breakerResetMs = 60000,
  } = options;

  const retryPolicy = retry(handleWhen(isRetryableError), {
    maxAttempts,
    backoff: new ExponentialBackoff({
      initialDelay: initialDelayMs,
      maxDelay: maxDelayMs,
      exponent: 2,
    }),
  });

  const breakerPolicy = circuitBreaker(handleWhen(shouldTripBreaker), {
    halfOpenAfter: breakerResetMs,
    breaker: new ConsecutiveBreaker(breakerThreshold),
  });

  const timeoutPolicy = timeout(timeoutMs);
  const bulkheadPolicy = bulkhead(maxConcurrent);

  return retryPolicy.compose(breakerPolicy.compose(timeoutPolicy.compose(bulkheadPolicy)));
}

/**
 * Create a lightweight retry-only policy (no circuit breaker).
 * Useful for idempotent operations like cookie refresh.
 */
export function createRetryPolicy(maxAttempts = 3, initialDelayMs = 1000): IPolicy<unknown> {
  return retry(handleAll, {
    maxAttempts,
    backoff: new ExponentialBackoff({
      initialDelay: initialDelayMs,
      maxDelay: 10000,
      exponent: 2,
    }),
  });
}

/**
 * Per-provider-type profile defaults. Mirrors PROVIDER_PROFILES in
 * open-sse/config/constants.ts but expressed as Cockatiel policy options.
 * Local providers get aggressive short timeouts; OAuth providers tolerate
 * longer recovery windows; API-key providers sit in between.
 */
const PROVIDER_TYPE_PROFILES: Record<ProviderType, Required<ProviderPolicyOptions>> = {
  oauth: {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    timeoutMs: 120000,
    maxConcurrent: 10,
    breakerThreshold: 8,
    breakerResetMs: 60000,
  },
  apikey: {
    maxAttempts: 4,
    initialDelayMs: 500,
    maxDelayMs: 20000,
    timeoutMs: 90000,
    maxConcurrent: 20,
    breakerThreshold: 12,
    breakerResetMs: 30000,
  },
  local: {
    maxAttempts: 2,
    initialDelayMs: 200,
    maxDelayMs: 5000,
    timeoutMs: 30000,
    maxConcurrent: 5,
    breakerThreshold: 2,
    breakerResetMs: 15000,
  },
};

/**
 * Build a composed resilience policy (retry + circuit breaker + timeout +
 * bulkhead) tuned for a provider type. The retry policy only retries
 * transient/retryable errors; the breaker only trips on genuine upstream
 * failures (404/401/403 are excluded so model-specific or credential issues
 * don't blacklist an entire provider).
 */
export function getResiliencePolicy(
  providerType: ProviderType,
  overrides: ProviderPolicyOptions = {}
): IPolicy<Response> {
  const profile = PROVIDER_TYPE_PROFILES[providerType] ?? PROVIDER_TYPE_PROFILES.apikey;
  const opts: Required<ProviderPolicyOptions> = { ...profile, ...overrides };
  return createProviderPolicy(`profile:${providerType}`, opts);
}

/**
 * Check if an error should trigger a circuit breaker trip.
 * Exported for use by the existing accountFallback.ts error classifier.
 */
export { shouldTripBreaker as shouldTripProviderBreaker };
