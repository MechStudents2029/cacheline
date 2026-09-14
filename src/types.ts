/** Cached value plus absolute expiry time (`Date.now()` milliseconds). */
export type CacheEntry = {
  value: unknown;
  expiresAt: number;
};

/**
 * Persistence for cache entries. Day 1 ships an in-memory store;
 * later days can add Redis without changing GetOrSet.
 */
export interface CacheStore {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

export type Loader<T> = () => T | Promise<T>;

export type GetOrSetOptions = {
  /** Time-to-live in milliseconds. Overrides `defaultTtlMs`. */
  ttlMs?: number;
};

export type CachelineOptions = {
  store?: CacheStore;
  /** Used when `getOrSet` is called without `ttlMs`. */
  defaultTtlMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
};
