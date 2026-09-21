import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { Cacheline, RedisStore } from "../src/index.js";

const REDIS_URL = process.env.CACHELINE_REDIS_URL ?? "redis://127.0.0.1:6379";

async function connectRedis(): Promise<Redis | undefined> {
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 400,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    await redis.ping();
    return redis;
  } catch {
    redis.disconnect();
    return undefined;
  }
}

describe("Redis integration", () => {
  let redis: Redis | undefined;
  const prefix = `cacheline:test:${process.pid}:${Date.now()}:`;
  const keys = ["item", "ttl", "zero"] as const;

  beforeAll(async () => {
    redis = await connectRedis();
    if (!redis) {
      console.warn(
        "Redis is not available; skipping integration tests. Start it with: docker compose up -d",
      );
    }
  });

  afterAll(async () => {
    if (!redis) {
      return;
    }
    await redis.del(...keys.map((key) => `${prefix}${key}`)).catch(() => 0);
    await redis.quit().catch(() => undefined);
  });

  it("round-trips CacheStore entries", async ({ skip }) => {
    if (!redis) {
      skip();
      return;
    }
    const store = new RedisStore(redis, { prefix });
    const entry = {
      value: { id: 1, name: "Ada" },
      expiresAt: Date.now() + 5_000,
      softExpiresAt: Date.now() + 4_000,
    };

    await store.set("item", entry);
    await expect(store.get("item")).resolves.toEqual(entry);
    await store.delete("item");
    await expect(store.get("item")).resolves.toBeUndefined();
  });

  it("serves Cacheline getOrSet hits and misses", async ({ skip }) => {
    if (!redis) {
      skip();
      return;
    }
    const cache = new Cacheline({
      store: new RedisStore(redis, { prefix }),
      defaultTtlMs: 5_000,
    });
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return "payload";
    };

    await expect(cache.getOrSet("item", loader)).resolves.toBe("payload");
    await expect(cache.getOrSet("item", loader)).resolves.toBe("payload");
    expect(loads).toBe(1);
    await expect(cache.get<string>("item")).resolves.toBe("payload");
  });

  it("reloads after hard TTL when the clock advances", async ({ skip }) => {
    if (!redis) {
      skip();
      return;
    }
    let now = Date.now();
    const cache = new Cacheline({
      store: new RedisStore(redis, { prefix }),
      defaultTtlMs: 100,
      now: () => now,
    });

    await expect(cache.getOrSet("ttl", async () => "fresh")).resolves.toBe(
      "fresh",
    );
    now += 99;
    await expect(cache.getOrSet("ttl", async () => "refreshed")).resolves.toBe(
      "fresh",
    );
    now += 1;
    await expect(cache.get("ttl")).resolves.toBeUndefined();
    await expect(cache.getOrSet("ttl", async () => "refreshed")).resolves.toBe(
      "refreshed",
    );
  });

  it("caches falsy values through Redis", async ({ skip }) => {
    if (!redis) {
      skip();
      return;
    }
    const cache = new Cacheline({
      store: new RedisStore(redis, { prefix }),
      defaultTtlMs: 5_000,
    });
    let loads = 0;

    await expect(
      cache.getOrSet("zero", async () => {
        loads += 1;
        return 0;
      }),
    ).resolves.toBe(0);
    await expect(cache.getOrSet("zero", async () => 1)).resolves.toBe(0);
    expect(loads).toBe(1);
  });
});
