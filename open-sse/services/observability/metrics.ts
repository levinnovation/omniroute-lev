// LEV fork: OpenTelemetry-style metrics for streaming resilience.
//
// Provides counter/gauge/histogram primitives for the key resilience signals:
//   - stream_readiness_ms: time from request dispatch to first SSE byte
//   - stream_early_eof_count: streams that ended before [DONE]
//   - provider_request_count: total upstream requests (success + failure)
//   - provider_error_count: upstream failures by provider
//   - combo_fallback_count: combo target fallbacks
//
// Uses a simple in-memory implementation with structured logging — no external
// OTLP exporter is needed. The primitives mirror the OpenTelemetry metrics
// API shape so an OTLP exporter can be dropped in later without changing
// call sites.
//
// Exports:
//   - recordStreamReadiness(provider, ms)
//   - recordStreamEarlyEof(provider)
//   - recordProviderRequest(provider, model, success)
//   - recordComboFallback(fromProvider, toProvider)
//   - getMetricsSnapshot(): point-in-time view (for dashboards/tests)

type LoggerLike =
  { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | null | undefined;

interface CounterState {
  value: number;
}

interface HistogramState {
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: Record<string, number>;
}

interface MetricsSnapshot {
  stream_readiness_ms: Record<string, HistogramState>;
  stream_early_eof_count: Record<string, CounterState>;
  provider_request_count: Record<string, CounterState>;
  provider_error_count: Record<string, CounterState>;
  combo_fallback_count: Record<string, CounterState>;
}

const HISTOGRAM_BOUNDARIES = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];

function bucketKey(ms: number): string {
  for (const boundary of HISTOGRAM_BOUNDARIES) {
    if (ms <= boundary) return `<=${boundary}`;
  }
  return `>${HISTOGRAM_BOUNDARIES[HISTOGRAM_BOUNDARIES.length - 1]}`;
}

function newCounter(): CounterState {
  return { value: 0 };
}

function newHistogram(): HistogramState {
  return { count: 0, sum: 0, min: Infinity, max: -Infinity, buckets: {} };
}

function incCounter(store: Record<string, CounterState>, key: string): void {
  const entry = store[key] ?? (store[key] = newCounter());
  entry.value += 1;
}

function recordHistogram(store: Record<string, HistogramState>, key: string, ms: number): void {
  const entry = store[key] ?? (store[key] = newHistogram());
  entry.count += 1;
  entry.sum += ms;
  entry.min = Math.min(entry.min, ms);
  entry.max = Math.max(entry.max, ms);
  const bk = bucketKey(ms);
  entry.buckets[bk] = (entry.buckets[bk] || 0) + 1;
}

const streamReadiness: Record<string, HistogramState> = {};
const streamEarlyEof: Record<string, CounterState> = {};
const providerRequest: Record<string, CounterState> = {};
const providerError: Record<string, CounterState> = {};
const comboFallback: Record<string, CounterState> = {};

let logger: LoggerLike = null;

export function setMetricsLogger(l: LoggerLike): void {
  logger = l;
}

function logMetric(
  level: "debug" | "warn",
  message: string,
  fields: Record<string, unknown>
): void {
  const fn = logger?.[level];
  if (typeof fn === "function") {
    fn("METRIC", message, fields);
  }
}

/**
 * Record the time (ms) from request dispatch to the first SSE byte for a
 * provider. Lower is better; sustained high values indicate a slow upstream
 * or a readiness-check bottleneck.
 */
export function recordStreamReadiness(provider: string, ms: number): void {
  recordHistogram(streamReadiness, provider, ms);
  logMetric("debug", "stream_readiness_ms", { provider, ms });
}

/**
 * Record that a stream ended before the [DONE] sentinel arrived (early EOF).
 * Frequent early EOFs for a provider suggest upstream instability.
 */
export function recordStreamEarlyEof(provider: string): void {
  incCounter(streamEarlyEof, provider);
  logMetric("warn", "stream_early_eof", { provider });
}

/**
 * Record an upstream provider request. `success` is true when the request
 * completed without an error status; false counts toward provider_error_count.
 */
export function recordProviderRequest(provider: string, model: string, success: boolean): void {
  incCounter(providerRequest, provider);
  if (!success) {
    incCounter(providerError, provider);
    logMetric("warn", "provider_error", { provider, model });
  } else {
    logMetric("debug", "provider_request", { provider, model });
  }
}

/**
 * Record a combo fallback from one provider to another.
 */
export function recordComboFallback(fromProvider: string, toProvider: string): void {
  const key = `${fromProvider}->${toProvider}`;
  incCounter(comboFallback, key);
  logMetric("debug", "combo_fallback", { fromProvider, toProvider });
}

/**
 * Return a point-in-time snapshot of all metrics. Useful for dashboards,
 * health endpoints, and tests.
 */
export function getMetricsSnapshot(): MetricsSnapshot {
  const cloneHistogram = (src: Record<string, HistogramState>): Record<string, HistogramState> => {
    const out: Record<string, HistogramState> = {};
    for (const [k, v] of Object.entries(src)) {
      out[k] = { ...v, buckets: { ...v.buckets } };
    }
    return out;
  };
  const cloneCounter = (src: Record<string, CounterState>): Record<string, CounterState> => {
    const out: Record<string, CounterState> = {};
    for (const [k, v] of Object.entries(src)) {
      out[k] = { ...v };
    }
    return out;
  };
  return {
    stream_readiness_ms: cloneHistogram(streamReadiness),
    stream_early_eof_count: cloneCounter(streamEarlyEof),
    provider_request_count: cloneCounter(providerRequest),
    provider_error_count: cloneCounter(providerError),
    combo_fallback_count: cloneCounter(comboFallback),
  };
}

/**
 * Reset all metrics. Intended for tests only.
 */
export function __resetMetricsForTests(): void {
  for (const key of Object.keys(streamReadiness)) delete streamReadiness[key];
  for (const key of Object.keys(streamEarlyEof)) delete streamEarlyEof[key];
  for (const key of Object.keys(providerRequest)) delete providerRequest[key];
  for (const key of Object.keys(providerError)) delete providerError[key];
  for (const key of Object.keys(comboFallback)) delete comboFallback[key];
}
