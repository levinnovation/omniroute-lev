const DEFAULT_TTL_MS = 60_000;
const CLEANUP_INTERVAL_MS = 30_000;

type Entry<T> = {
  value: T;
  expiresAt: number;
};

export class TtlCache {
  private store = new Map<string, Entry<unknown>>();
  private defaultTtlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(defaultTtlMs: number = DEFAULT_TTL_MS) {
    this.defaultTtlMs = defaultTtlMs;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number = this.defaultTtlMs): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    this.ensureCleanup();
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidatePattern(pattern: string): void {
    const regex = new RegExp(pattern);
    for (const key of this.store.keys()) {
      if (regex.test(key)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  private ensureCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (
      this.cleanupTimer &&
      typeof this.cleanupTimer === "object" &&
      "unref" in this.cleanupTimer
    ) {
      (this.cleanupTimer as { unref: () => void }).unref();
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) this.store.delete(key);
    }
    if (this.store.size === 0 && this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

export const ttlCache = new TtlCache();
