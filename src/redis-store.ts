import type { CacheEntry, CacheStore } from "./types.js";

const DEFAULT_PREFIX = "cacheline:";

/**
 * Minimal Redis surface used by {@link RedisStore}.
 * Compatible with ioredis `get` / `set(key, value, "PX", ttlMs)` / `del`.
 */
export type RedisStoreClient = {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    px?: "PX",
    ttlMs?: number,
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

export type RedisStoreOptions = {
  /** Prepended to every cache key. Default `cacheline:`. */
  prefix?: string;
};

/**
 * Redis-backed {@link CacheStore}. Pass any client that speaks GET/SET/DEL
 * (ioredis works as-is). Values must be JSON-serializable.
 *
 * In-memory remains the Cacheline default; this store is opt-in:
 * `new Cacheline({ store: new RedisStore(redis) })`.
 */
export class RedisStore implements CacheStore {
  private readonly redis: RedisStoreClient;
  private readonly prefix: string;

  constructor(redis: RedisStoreClient, options: RedisStoreOptions = {}) {
    this.redis = redis;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
  }

  private namespaced(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    const raw = await this.redis.get(this.namespaced(key));
    if (raw === null) {
      return undefined;
    }
    const entry = parseCacheEntry(raw);
    if (!entry) {
      await this.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    const ttlMs = Math.max(1, entry.expiresAt - Date.now());
    await this.redis.set(
      this.namespaced(key),
      JSON.stringify(entry),
      "PX",
      ttlMs,
    );
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.namespaced(key));
  }
}

function parseCacheEntry(raw: string): CacheEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isCacheEntry(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const entry = value as { expiresAt?: unknown; softExpiresAt?: unknown };
  if (typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt)) {
    return false;
  }
  if (
    entry.softExpiresAt !== undefined &&
    (typeof entry.softExpiresAt !== "number" ||
      !Number.isFinite(entry.softExpiresAt))
  ) {
    return false;
  }
  return true;
}
