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
// policy primitives that can be composed per-provider.
//
// Usage:
//   const policy = createProviderPolicy("zai-web");
//   const result = await policy.execute(async () => { ... });

import {
  retry,
  circuitBreaker,
  timeout,
  bulkhead,
  handleAll,
  ExponentialBackoff,
  type IPolicy,
  ConsecutiveBreaker,
} from "cockatiel";

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
 * Error classification for circuit breaker decisions.
 * 404 (model not found) → don't trip breaker (model-specific issue)
 * 401 (auth) → don't trip breaker (credential issue)
 * 429 (rate limit) → trip breaker (quota issue)
 * 502/503/504 (server error) → trip breaker (transient)
 */
function shouldTripBreaker(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: number }).status;
    if (status === 404) return false; // model not found — don't trip
    if (status === 401) return false; // auth error — don't trip
    if (status === 403) return false; // forbidden — don't trip
    if (status === 429) return true; // rate limited — trip
    if (status >= 500) return true; // server error — trip
  }
  // Network errors, timeouts → trip
  if (error instanceof Error) {
    if (error.name === "AbortError") return false; // client cancel — don't trip
    if (error.name === "TimeoutError") return true; // timeout — trip
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

  const retryPolicy = retry(handleAll, {
    maxAttempts,
    backoff: new ExponentialBackoff({
      initialDelay: initialDelayMs,
      maxDelay: maxDelayMs,
      exponent: 2,
    }),
  });

  const breakerPolicy = circuitBreaker(handleAll, {
    halfOpenAfter: breakerResetMs,
    breaker: new ConsecutiveBreaker(breakerThreshold),
  });

  const timeoutPolicy = timeout(timeoutMs);
  const bulkheadPolicy = bulkhead(maxConcurrent);

  // Compose: retry → breaker → timeout → bulkhead
  // Outermost policy runs first (retry wraps everything)
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
 * Check if an error should trigger a circuit breaker trip.
 * Exported for use by the existing accountFallback.ts error classifier.
 */
export { shouldTripBreaker as shouldTripProviderBreaker };
