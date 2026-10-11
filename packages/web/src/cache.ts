/**
 * Small in-memory TTL cache for RPC reads. One public page view would otherwise fan out to hundreds
 * of RPC calls (getProgramAccounts, then up to 50 getTransaction calls per loan), which public RPC
 * endpoints rate-limit. Concurrent callers for the same key share one in-flight load, and a failed
 * load is never cached, so the next request retries.
 */
export interface TtlCacheOptions {
  /** How long a loaded value is served before it is loaded again. */
  ttlMs: number;
  /** Oldest entries are dropped beyond this many keys (bounds memory under address scanning). */
  maxEntries?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export interface TtlCache<V> {
  /** The cached value for `key`, or the result of `load()` (which is then cached for `ttlMs`). */
  get(key: string, load: () => Promise<V>): Promise<V>;
  /** Number of live (unexpired or in-flight) entries. */
  size(): number;
  clear(): void;
}

interface Entry<V> {
  readonly value: Promise<V>;
  readonly expiresAt: number;
}

export const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 500;

/** TTL from an env string in milliseconds; anything missing, non-numeric or negative falls back. */
export function ttlFromEnv(raw: string | undefined, fallback = DEFAULT_CACHE_TTL_MS): number {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function createTtlCache<V>({ ttlMs, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now }: TtlCacheOptions): TtlCache<V> {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error(`ttlMs must be a non-negative number, got ${ttlMs}`);
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error(`maxEntries must be a positive integer, got ${maxEntries}`);
  const entries = new Map<string, Entry<V>>();

  const prune = (t: number) => {
    for (const [k, e] of entries) if (e.expiresAt <= t) entries.delete(k);
    // Map keeps insertion order, so the first keys are the oldest.
    for (const k of [...entries.keys()].slice(0, Math.max(0, entries.size - maxEntries))) entries.delete(k);
  };

  return {
    get(key, load) {
      const t = now();
      const hit = entries.get(key);
      if (hit && hit.expiresAt > t) return hit.value;
      if (ttlMs === 0) return load();
      const value = load();
      const entry: Entry<V> = { value, expiresAt: t + ttlMs };
      entries.delete(key);
      entries.set(key, entry);
      prune(t);
      // Do not keep failures: drop this entry (only if it is still the current one) so the next call retries.
      value.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return value;
    },
    size() {
      prune(now());
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}
