/** Cached value plus absolute expiry time (`Date.now()` milliseconds). */
export type CacheEntry = {
  value: unknown;
  /** Hard TTL: the entry is a miss at or after this timestamp. */
  expiresAt: number;
  /**
   * Soft TTL / early-refresh watermark. When `now >= softExpiresAt` but
   * `now < expiresAt`, `getOrSet` serves this value and refreshes in the
   * background. Omitted (or equal to `expiresAt`) means no early refresh.
   */
  softExpiresAt?: number;
};

/**
 * Persistence for cache entries. In-memory is the default;
 * Redis is an optional backend (`RedisStore`) with the same contract.
 */
export interface CacheStore {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

export type Loader<T> = () => T | Promise<T>;

/**
 * Counters for `Cacheline.getOrSet`.
 * `hits` are fresh or soft-stale serves. `misses` start a loader.
 * `coalesced` calls found no live entry and joined an in-flight load.
 */
export type CacheMetrics = {
  hits: number;
  misses: number;
  coalesced: number;
};

export type GetOrSetOptions = {
  /** Time-to-live in milliseconds. Overrides `defaultTtlMs`. */
  ttlMs?: number;
  /**
   * Fraction of TTL to randomize expiry by, in `[0, 1]`.
   * `0.1` spreads expiry uniformly in `[0.9, 1.1] * ttlMs`.
   */
  jitterRatio?: number;
  /**
   * Fraction of the (jittered) hard TTL treated as fresh.
   * `0.8` with a 1000ms TTL starts a background refresh after 800ms.
   */
  softTtlRatio?: number;
  /**
   * Remaining TTL (ms) at which early refresh starts. When set, this
   * remaining-TTL window wins over `softTtlRatio`.
   */
  earlyRefreshMs?: number;
};

export type CachelineOptions = {
  store?: CacheStore;
  /** Used when `getOrSet` is called without `ttlMs`. */
  defaultTtlMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Fraction of TTL to randomize expiry by, in `[0, 1]`.
   * Default `0` keeps expiry deterministic (Day 1 behavior).
   */
  jitterRatio?: number;
  /**
   * Fraction of the (jittered) hard TTL treated as fresh.
   * After this point `getOrSet` serves the cached value and reloads in the
   * background so callers are not blocked.
   */
  softTtlRatio?: number;
  /**
   * Remaining TTL (ms) that triggers early refresh. Alternative to
   * `softTtlRatio`; wins when both are set.
   */
  earlyRefreshMs?: number;
  /** RNG in `[0, 1)`. Injectable for tests. Defaults to `Math.random`. */
  random?: () => number;
};
