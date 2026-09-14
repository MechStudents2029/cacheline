import { describe, expect, it, vi } from "vitest";
import { Cacheline, MemoryStore, Singleflight } from "../src/index.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("Cacheline.getOrSet", () => {
  it("loads on miss and returns the cached value on hit (happy path)", async () => {
    const cache = new Cacheline({ defaultTtlMs: 5_000 });
    const loader = vi.fn().mockResolvedValue("payload");

    await expect(cache.getOrSet("item", loader)).resolves.toBe("payload");
    await expect(cache.getOrSet("item", loader)).resolves.toBe("payload");
    expect(loader).toHaveBeenCalledTimes(1);
    await expect(cache.get<string>("item")).resolves.toBe("payload");
  });

  it("reloads after TTL expiry", async () => {
    let now = 1_000;
    const cache = new Cacheline({
      defaultTtlMs: 100,
      now: () => now,
    });
    const loader = vi
      .fn()
      .mockResolvedValueOnce("fresh")
      .mockResolvedValueOnce("refreshed");

    await expect(cache.getOrSet("k", loader)).resolves.toBe("fresh");

    now = 1_099;
    await expect(cache.getOrSet("k", loader)).resolves.toBe("fresh");
    expect(loader).toHaveBeenCalledTimes(1);

    now = 1_100;
    await expect(cache.get("k")).resolves.toBeUndefined();
    await expect(cache.getOrSet("k", loader)).resolves.toBe("refreshed");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("honors per-call ttlMs over the default", async () => {
    let now = 0;
    const cache = new Cacheline({
      defaultTtlMs: 10_000,
      now: () => now,
    });
    const loader = vi
      .fn()
      .mockResolvedValueOnce("a")
      .mockResolvedValueOnce("b");

    await cache.getOrSet("k", loader, { ttlMs: 50 });
    now = 50;
    await expect(cache.getOrSet("k", loader, { ttlMs: 50 })).resolves.toBe("b");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("coalesces duplicate in-flight loads for the same key", async () => {
    const cache = new Cacheline({ defaultTtlMs: 5_000 });
    const load = deferred<string>();
    const loader = vi.fn(() => load.promise);

    const requests = [
      cache.getOrSet("user:1", loader),
      cache.getOrSet("user:1", loader),
      cache.getOrSet("user:1", loader),
    ];

    await flushMicrotasks();
    expect(loader).toHaveBeenCalledTimes(1);

    load.resolve("alice");
    await expect(Promise.all(requests)).resolves.toEqual([
      "alice",
      "alice",
      "alice",
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce loads for different keys", async () => {
    const cache = new Cacheline({ defaultTtlMs: 5_000 });
    const first = deferred<string>();
    const second = deferred<string>();
    const loaderA = vi.fn(() => first.promise);
    const loaderB = vi.fn(() => second.promise);

    const a = cache.getOrSet("a", loaderA);
    const b = cache.getOrSet("b", loaderB);

    await flushMicrotasks();
    expect(loaderA).toHaveBeenCalledTimes(1);
    expect(loaderB).toHaveBeenCalledTimes(1);

    first.resolve("A");
    second.resolve("B");
    await expect(Promise.all([a, b])).resolves.toEqual(["A", "B"]);
  });

  it("does not cache a failed load; a later call retries", async () => {
    const cache = new Cacheline({ defaultTtlMs: 5_000 });
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce("recovered");

    await expect(cache.getOrSet("k", loader)).rejects.toThrow("upstream down");
    await expect(cache.getOrSet("k", loader)).resolves.toBe("recovered");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("rejects all coalesced waiters when the in-flight load fails", async () => {
    const cache = new Cacheline({ defaultTtlMs: 5_000 });
    const load = deferred<string>();
    const loader = vi.fn(() => load.promise);

    const requests = [
      cache.getOrSet("k", loader),
      cache.getOrSet("k", loader),
    ];

    await flushMicrotasks();
    load.reject(new Error("boom"));

    await expect(Promise.allSettled(requests)).resolves.toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: "boom" }) },
      { status: "rejected", reason: expect.objectContaining({ message: "boom" }) },
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("caches falsy values", async () => {
    const cache = new Cacheline({ defaultTtlMs: 5_000 });
    const loader = vi.fn().mockResolvedValue(0);

    await expect(cache.getOrSet("zero", loader)).resolves.toBe(0);
    await expect(cache.getOrSet("zero", loader)).resolves.toBe(0);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("throws when no TTL is configured", async () => {
    const cache = new Cacheline();
    await expect(cache.getOrSet("k", async () => 1)).rejects.toThrow(/ttlMs is required/);
  });
});

describe("Singleflight", () => {
  it("runs the function once while waiters share the result", async () => {
    const sf = new Singleflight();
    const load = deferred<number>();
    const fn = vi.fn(() => load.promise);

    const requests = [sf.do("n", fn), sf.do("n", fn), sf.do("n", fn)];
    expect(fn).toHaveBeenCalledTimes(1);

    load.resolve(42);
    await expect(Promise.all(requests)).resolves.toEqual([42, 42, 42]);
  });
});

describe("MemoryStore", () => {
  it("round-trips entries", () => {
    const store = new MemoryStore();
    store.set("k", { value: { n: 1 }, expiresAt: 10 });
    expect(store.get("k")).toEqual({ value: { n: 1 }, expiresAt: 10 });
    store.delete("k");
    expect(store.get("k")).toBeUndefined();
  });
});
