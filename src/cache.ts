import { MemoryStore } from "./memory-store.js";
import { Singleflight } from "./singleflight.js";
import {
  applyJitter,
  computeSoftExpiresAt,
  resolveEarlyRefreshMs,
  resolveJitterRatio,
  resolveSoftTtlRatio,
} from "./ttl.js";
import type {
  CacheEntry,
  CachelineOptions,
  CacheMetrics,
  CacheStore,
  GetOrSetOptions,
  Loader,
} from "./types.js";

type TtlConfig = {
  ttlMs: number;
  jitterRatio: number;
  softTtlRatio: number | undefined;
  earlyRefreshMs: number | undefined;
};

type Lookup<T> =
  | { status: "fresh"; value: T }
  | { status: "stale"; value: T }
  | { status: "miss" };

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
 * GetOrSet cache: return a live entry, or load once (singleflight) and store
 * with TTL. Optional soft TTL serves stale values and refreshes in the
 * background; optional jitter spreads expiry times.
 *
 * `metrics()` counts hits, misses, and coalesced singleflight waits.
 */
export class Cacheline {
  private readonly store: CacheStore;
  private readonly defaultTtlMs: number | undefined;
  private readonly defaultJitterRatio: number;
  private readonly defaultSoftTtlRatio: number | undefined;
  private readonly defaultEarlyRefreshMs: number | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly singleflight = new Singleflight();
  private readonly counters: CacheMetrics = {
    hits: 0,
    misses: 0,
    coalesced: 0,
  };

  constructor(options: CachelineOptions = {}) {
    this.store = options.store ?? new MemoryStore();
    this.defaultTtlMs = options.defaultTtlMs;
    this.defaultJitterRatio = resolveJitterRatio(options.jitterRatio);
    this.defaultSoftTtlRatio = resolveSoftTtlRatio(options.softTtlRatio);
    this.defaultEarlyRefreshMs = resolveEarlyRefreshMs(options.earlyRefreshMs);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /**
   * Return the cached value for `key`, or run `loader` if missing/expired.
   * Concurrent loads for the same key share one in-flight call.
   *
   * When the entry is past soft TTL but still within hard TTL, the cached
   * value is returned immediately and a coalesced background refresh starts.
   */
  async getOrSet<T>(
    key: string,
    loader: Loader<T>,
    options?: GetOrSetOptions,
  ): Promise<T> {
    const ttl = this.resolveTtlConfig(options);

    const hit = await this.lookup<T>(key);
    if (hit.status === "fresh" || hit.status === "stale") {
      this.counters.hits += 1;
      if (hit.status === "stale") {
        this.scheduleRefresh(key, loader, ttl);
      }
      return hit.value;
    }

    if (this.singleflight.isInFlight(key)) {
      this.counters.coalesced += 1;
    } else {
      this.counters.misses += 1;
    }
    return this.loadAndStore(key, loader, ttl);
  }

  /**
   * Snapshot of hit / miss / coalesce counters. Mutating the result does not
   * change the cache. `get` does not move these counters.
   */
  metrics(): CacheMetrics {
    return { ...this.counters };
  }

  /** Zero hit / miss / coalesce counters. */
  resetMetrics(): void {
    this.counters.hits = 0;
    this.counters.misses = 0;
    this.counters.coalesced = 0;
  }

  /** Cached value within hard TTL (including stale), or `undefined`. */
  async get<T>(key: string): Promise<T | undefined> {
    const hit = await this.lookup<T>(key);
    return hit.status === "miss" ? undefined : hit.value;
  }

  private resolveTtlConfig(options: GetOrSetOptions | undefined): TtlConfig {
    return {
      ttlMs: resolveTtlMs(options, this.defaultTtlMs),
      jitterRatio: resolveJitterRatio(
        options?.jitterRatio ?? this.defaultJitterRatio,
      ),
      softTtlRatio: resolveSoftTtlRatio(
        options?.softTtlRatio ?? this.defaultSoftTtlRatio,
      ),
      earlyRefreshMs: resolveEarlyRefreshMs(
        options?.earlyRefreshMs ?? this.defaultEarlyRefreshMs,
      ),
    };
  }

  private makeEntry(value: unknown, ttl: TtlConfig): CacheEntry {
    const now = this.now();
    const jitteredTtlMs = applyJitter(ttl.ttlMs, ttl.jitterRatio, this.random);
    const expiresAt = now + jitteredTtlMs;
    const softExpiresAt = computeSoftExpiresAt(
      now,
      expiresAt,
      jitteredTtlMs,
      ttl.earlyRefreshMs,
      ttl.softTtlRatio,
    );
    return { value, expiresAt, softExpiresAt };
  }

  private loadAndStore<T>(
    key: string,
    loader: Loader<T>,
    ttl: TtlConfig,
  ): Promise<T> {
    return this.singleflight.do(key, async () => {
      const raced = await this.lookup<T>(key);
      if (raced.status === "fresh") {
        return raced.value;
      }

      const value = await loader();
      await this.store.set(key, this.makeEntry(value, ttl));
      return value;
    });
  }

  /** Fire-and-forget refresh; errors keep the stale value until hard expiry. */
  private scheduleRefresh<T>(
    key: string,
    loader: Loader<T>,
    ttl: TtlConfig,
  ): void {
    void this.loadAndStore(key, loader, ttl).catch(() => undefined);
  }

  private async lookup<T>(key: string): Promise<Lookup<T>> {
    const entry = await this.store.get(key);
    if (!entry) {
      return { status: "miss" };
    }
    const now = this.now();
    if (now >= entry.expiresAt) {
      await this.store.delete(key);
      return { status: "miss" };
    }
    const softExpiresAt = entry.softExpiresAt ?? entry.expiresAt;
    if (now >= softExpiresAt) {
      return { status: "stale", value: entry.value as T };
    }
    return { status: "fresh", value: entry.value as T };
  }
}

export function createCache(options?: CachelineOptions): Cacheline {
  return new Cacheline(options);
}
