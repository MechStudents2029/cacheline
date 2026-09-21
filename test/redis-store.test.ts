import { describe, expect, it } from "vitest";
import { RedisStore, type RedisStoreClient } from "../src/index.js";

function memoryRedis(): RedisStoreClient & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async set(key: string, value: string, _px?: "PX", _ttlMs?: number) {
      data.set(key, value);
      return "OK";
    },
    async del(key: string) {
      return data.delete(key) ? 1 : 0;
    },
  };
}

describe("RedisStore", () => {
  it("round-trips entries with the default key prefix", async () => {
    const redis = memoryRedis();
    const store = new RedisStore(redis);
    const entry = { value: { n: 1 }, expiresAt: Date.now() + 5_000 };

    await store.set("k", entry);
    expect(redis.data.has("cacheline:k")).toBe(true);
    await expect(store.get("k")).resolves.toEqual(entry);

    await store.delete("k");
    await expect(store.get("k")).resolves.toBeUndefined();
    expect(redis.data.has("cacheline:k")).toBe(false);
  });

  it("honors a custom prefix", async () => {
    const redis = memoryRedis();
    const store = new RedisStore(redis, { prefix: "app:" });
    await store.set("user", { value: "ada", expiresAt: 10 });
    expect([...redis.data.keys()]).toEqual(["app:user"]);
    await expect(store.get("user")).resolves.toEqual({
      value: "ada",
      expiresAt: 10,
    });
  });

  it("treats missing keys as empty", async () => {
    const store = new RedisStore(memoryRedis());
    await expect(store.get("missing")).resolves.toBeUndefined();
  });

  it("drops malformed payloads so a later load can refill", async () => {
    const redis = memoryRedis();
    redis.data.set("cacheline:bad", "{not-json");
    const store = new RedisStore(redis);

    await expect(store.get("bad")).resolves.toBeUndefined();
    expect(redis.data.has("cacheline:bad")).toBe(false);
  });

  it("drops payloads that are not cache entries", async () => {
    const redis = memoryRedis();
    redis.data.set("cacheline:bad", JSON.stringify({ value: 1 }));
    const store = new RedisStore(redis);

    await expect(store.get("bad")).resolves.toBeUndefined();
    expect(redis.data.has("cacheline:bad")).toBe(false);
  });

  it("passes PX milliseconds so Redis can expire keys", async () => {
    const calls: Array<unknown[]> = [];
    const redis: RedisStoreClient = {
      async get() {
        return null;
      },
      async set(...args) {
        calls.push(args);
        return "OK";
      },
      async del() {
        return 1;
      },
    };
    const store = new RedisStore(redis);
    const expiresAt = Date.now() + 1_500;
    await store.set("k", { value: "v", expiresAt, softExpiresAt: expiresAt });

    expect(calls).toHaveLength(1);
    const [key, payload, px, ttlMs] = calls[0] as [
      string,
      string,
      string,
      number,
    ];
    expect(key).toBe("cacheline:k");
    expect(px).toBe("PX");
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(1_500);
    expect(JSON.parse(payload)).toEqual({
      value: "v",
      expiresAt,
      softExpiresAt: expiresAt,
    });
  });
});
