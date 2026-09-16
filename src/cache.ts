import { MemoryStore } from "./memory-store.js";
import { Singleflight } from "./singleflight.js";
import type {
  CachelineOptions,
  CacheStore,
  GetOrSetOptions,
  Loader,
} from "./types.js";

function resolveTtlMs(
  options: GetOrSetOptions | undefined,
  defaultTtlMs: number | undefined,
): number {
  const ttlMs = options?.ttlMs ?? defaultTtlMs;
  if (ttlMs === undefined) {
    throw new Error(
      "ttlMs is required: pass GetOrSetOptions.ttlMs or CachelineOptions.defaultTtlMs",
    );
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("ttlMs must be a positive finite number");
  }
  return ttlMs;
}

/**
 * GetOrSet cache: return a live entry, or load once (singleflight) and store with TTL.
 */
export class Cacheline {
  private readonly store: CacheStore;
  private readonly defaultTtlMs: number | undefined;
  private readonly now: () => number;
  private readonly singleflight = new Singleflight();

  constructor(options: CachelineOptions = {}) {
    this.store = options.store ?? new MemoryStore();
    this.defaultTtlMs = options.defaultTtlMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * Return the cached value for `key`, or run `loader` if missing/expired.
   * Concurrent loads for the same key share one in-flight call.
   */
  async getOrSet<T>(
    key: string,
    loader: Loader<T>,
    options?: GetOrSetOptions,
  ): Promise<T> {
    const ttlMs = resolveTtlMs(options, this.defaultTtlMs);

    const hit = await this.lookup<T>(key);
    if (hit.found) {
      return hit.value;
    }

    return this.singleflight.do(key, async () => {
      const raced = await this.lookup<T>(key);
      if (raced.found) {
        return raced.value;
      }

      const value = await loader();
      await this.store.set(key, {
        value,
        expiresAt: this.now() + ttlMs,
      });
      return value;
    });
  }

  /** Fresh cached value, or `undefined` if missing or expired. */
  async get<T>(key: string): Promise<T | undefined> {
    const hit = await this.lookup<T>(key);
    return hit.found ? hit.value : undefined;
  }

  private async lookup<T>(
    key: string,
  ): Promise<{ found: true; value: T } | { found: false }> {
    const entry = await this.store.get(key);
    if (!entry) {
      return { found: false };
    }
    if (this.now() >= entry.expiresAt) {
      await this.store.delete(key);
      return { found: false };
    }
    return { found: true, value: entry.value as T };
  }
}

export function createCache(options?: CachelineOptions): Cacheline {
  return new Cacheline(options);
}
