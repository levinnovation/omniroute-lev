import { getUpstreamProxyConfig } from "@/lib/localDb";
import type { FallbackBackend } from "@/lib/db/upstreamProxy";
import { TtlCache } from "../../services/ttlCache.ts";

/**
 * Module-level cache for upstream proxy config (shared across all requests).
 * 10s TTL prevents per-request DB lookups while staying fresh enough for setting changes.
 */
type UpstreamProxyConfigCacheEntry = {
  mode: string;
  enabled: boolean;
  cliproxyapiModelMapping: Record<string, unknown> | null;
  // #dario: retry-leg backend when mode === "fallback".
  fallbackBackend: FallbackBackend;
  ts: number;
};

const _proxyConfigCache = new Map<string, UpstreamProxyConfigCacheEntry>();
const PROXY_CONFIG_CACHE_TTL = 10_000;

const COMBOS_CACHE_KEY = "combos";
const COMBOS_CACHE_TTL = 10_000;
const _combosCache = new TtlCache(COMBOS_CACHE_TTL);
let _combosCacheVersionSnapshot = -1;

type CombosCacheEntry = {
  promise: Promise<unknown[]>;
  version: number;
};

export async function getCombosCached(): Promise<unknown[]> {
  const { getCombos, getCombosCacheVersion } = await import("@/lib/localDb");
  const version = getCombosCacheVersion();
  // A combo write (create/update/delete/reorder) bumps the shared version via
  // invalidateDbCache("combos"); when it no longer matches our snapshot we drop
  // the cached promise so the nested-combo expansion stops serving removed
  // targets/models within the 10s TTL window (#3147).
  if (version !== _combosCacheVersionSnapshot) {
    clearCombosCache();
  }
  const cached = _combosCache.get<CombosCacheEntry>(COMBOS_CACHE_KEY);
  if (cached && cached.version === version) {
    return cached.promise;
  }
  _combosCacheVersionSnapshot = version;
  const promise = getCombos();
  _combosCache.set<CombosCacheEntry>(COMBOS_CACHE_KEY, { promise, version }, COMBOS_CACHE_TTL);
  return promise;
}

export function clearCombosCache() {
  _combosCache.invalidate(COMBOS_CACHE_KEY);
  _combosCacheVersionSnapshot = -1;
}

export function clearUpstreamProxyConfigCache(providerId?: string) {
  if (providerId) {
    _proxyConfigCache.delete(providerId);
    return;
  }
  _proxyConfigCache.clear();
}

export async function getUpstreamProxyConfigCached(providerId: string) {
  const cached = _proxyConfigCache.get(providerId);
  if (cached && Date.now() - cached.ts < PROXY_CONFIG_CACHE_TTL) return cached;
  const cfg = await getUpstreamProxyConfig(providerId).catch(() => null);
  const result: UpstreamProxyConfigCacheEntry = cfg
    ? {
        mode: cfg.mode,
        enabled: cfg.enabled,
        cliproxyapiModelMapping: cfg.cliproxyapiModelMapping ?? null,
        fallbackBackend: cfg.fallbackBackend,
        ts: Date.now(),
      }
    : {
        mode: "native" as const,
        enabled: false,
        cliproxyapiModelMapping: null,
        fallbackBackend: "cliproxyapi" as const,
        ts: Date.now(),
      };
  _proxyConfigCache.set(providerId, result);
  return result;
}
