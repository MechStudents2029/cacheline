import { describe, expect, it, vi } from "vitest";
import { Cacheline, MemoryStore, Singleflight } from "../src/index.js";
import { applyJitter, computeSoftExpiresAt } from "../src/ttl.js";

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

describe("TTL jitter", () => {
  it("spreads expiry symmetrically around the nominal TTL", () => {
    expect(applyJitter(100, 0, () => 0.5)).toBe(100);
    expect(applyJitter(100, 0.1, () => 0.5)).toBe(100);
    expect(applyJitter(100, 0.1, () => 0)).toBe(90);
    expect(applyJitter(100, 0.1, () => 1)).toBeCloseTo(110);
  });

  it("applies jitter when storing so hard expiry moves", async () => {
    let now = 1_000;
    const cache = new Cacheline({
      defaultTtlMs: 100,
      jitterRatio: 0.1,
      now: () => now,
      random: () => 0,
    });
    const loader = vi
      .fn()
      .mockResolvedValueOnce("fresh")
      .mockResolvedValueOnce("refreshed");

    await cache.getOrSet("k", loader);

    now = 1_089;
    await expect(cache.getOrSet("k", loader)).resolves.toBe("fresh");
    expect(loader).toHaveBeenCalledTimes(1);

    now = 1_090;
    await expect(cache.get("k")).resolves.toBeUndefined();
    await expect(cache.getOrSet("k", loader)).resolves.toBe("refreshed");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("honors per-call jitterRatio over the constructor default", async () => {
    let now = 0;
    const cache = new Cacheline({
      defaultTtlMs: 100,
      jitterRatio: 0,
      now: () => now,
      random: () => 0,
    });
    const loader = vi
      .fn()
      .mockResolvedValueOnce("a")
      .mockResolvedValueOnce("b");

    await cache.getOrSet("k", loader, { jitterRatio: 0.2 });
    now = 79;
    await expect(cache.getOrSet("k", loader, { jitterRatio: 0.2 })).resolves.toBe(
      "a",
    );
    now = 80;
    await expect(cache.getOrSet("k", loader, { jitterRatio: 0.2 })).resolves.toBe(
      "b",
    );
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("soft TTL / early refresh", () => {
  it("computes a remaining-TTL window and a ratio window", () => {
    expect(computeSoftExpiresAt(1000, 1100, 100, 20, undefined)).toBe(1080);
    expect(computeSoftExpiresAt(1000, 1100, 100, undefined, 0.8)).toBe(1080);
    expect(computeSoftExpiresAt(1000, 1100, 100, undefined, undefined)).toBe(
      1100,
    );
  });

  it("serves stale immediately and refreshes in the background", async () => {
    let now = 0;
    const cache = new Cacheline({
      defaultTtlMs: 100,
      softTtlRatio: 0.8,
      now: () => now,
    });
    const load = deferred<string>();
    const loader = vi.fn(() => load.promise);

    await cache.getOrSet("k", async () => "v1");

    now = 80;
    const pending = cache.getOrSet("k", loader);
    await expect(pending).resolves.toBe("v1");

    await flushMicrotasks();
    expect(loader).toHaveBeenCalledTimes(1);

    load.resolve("v2");
    await vi.waitFor(async () => {
      expect(await cache.get<string>("k")).toBe("v2");
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("starts early refresh from remaining TTL via earlyRefreshMs", async () => {
    let now = 0;
    const cache = new Cacheline({
      defaultTtlMs: 100,
      earlyRefreshMs: 25,
      now: () => now,
    });
    const loader = vi
      .fn()
      .mockResolvedValueOnce("v1")
      .mockResolvedValueOnce("v2");

    await cache.getOrSet("k", loader);
    expect(loader).toHaveBeenCalledTimes(1);

    now = 74;
    await expect(cache.getOrSet("k", loader)).resolves.toBe("v1");
    expect(loader).toHaveBeenCalledTimes(1);

    now = 75;
    await expect(cache.getOrSet("k", loader)).resolves.toBe("v1");
    await vi.waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(async () => {
      expect(await cache.get<string>("k")).toBe("v2");
    });
  });

  it("does not refresh again while a background reload is in flight", async () => {
    let now = 0;
    const cache = new Cacheline({
      defaultTtlMs: 100,
      softTtlRatio: 0.5,
      now: () => now,
    });
    const load = deferred<string>();
    const loader = vi.fn(() => load.promise);

    await cache.getOrSet("k", async () => "stale");
    now = 50;

    await expect(cache.getOrSet("k", loader)).resolves.toBe("stale");
    await expect(cache.getOrSet("k", loader)).resolves.toBe("stale");
    await flushMicrotasks();
    expect(loader).toHaveBeenCalledTimes(1);

    load.resolve("fresh");
    await vi.waitFor(async () => {
      expect(await cache.get<string>("k")).toBe("fresh");
    });
  });

  it("keeps the stale value when a background refresh fails", async () => {
    let now = 0;
    const cache = new Cacheline({
      defaultTtlMs: 100,
      softTtlRatio: 0.8,
      now: () => now,
    });
    const load = deferred<string>();
    const loader = vi.fn(() => load.promise);

    await cache.getOrSet("k", async () => "stale");
    now = 80;

    await expect(cache.getOrSet("k", loader)).resolves.toBe("stale");
    await flushMicrotasks();
    load.reject(new Error("upstream down"));

    await flushMicrotasks();
    await expect(cache.get<string>("k")).resolves.toBe("stale");
    await expect(cache.getOrSet("k", loader)).resolves.toBe("stale");
  });

  it("misses and blocks once hard TTL expires", async () => {
    let now = 0;
    const cache = new Cacheline({
      defaultTtlMs: 100,
      softTtlRatio: 0.8,
      now: () => now,
    });
    const load = deferred<string>();
    const loader = vi.fn(() => load.promise);

    await cache.getOrSet("k", async () => "v1");
    now = 100;

    const pending = cache.getOrSet("k", loader);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(loader).toHaveBeenCalledTimes(1);

    load.resolve("v2");
    await expect(pending).resolves.toBe("v2");
  });
});

describe("thundering herd / stampede", () => {
  it("coalesces many concurrent getOrSet calls after hard TTL expiry", async () => {
    let now = 0;
    const cache = new Cacheline({
      defaultTtlMs: 50,
      now: () => now,
    });
    await cache.getOrSet("hot", async () => "v1");

    now = 50;
    const load = deferred<string>();
    const loader = vi.fn(() => load.promise);

    const herd = Array.from({ length: 40 }, () => cache.getOrSet("hot", loader));
    await flushMicrotasks();
    expect(loader).toHaveBeenCalledTimes(1);

    load.resolve("v2");
    await expect(Promise.all(herd)).resolves.toEqual(Array(40).fill("v2"));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("serves stale to a herd in the soft-TTL window with one background refresh", async () => {
    let now = 0;
    const cache = new Cacheline({
      defaultTtlMs: 100,
      softTtlRatio: 0.8,
      now: () => now,
    });
    await cache.getOrSet("hot", async () => "v1");

    now = 80;
    const load = deferred<string>();
    const loader = vi.fn(() => load.promise);

    const herd = Array.from({ length: 40 }, () => cache.getOrSet("hot", loader));
    await expect(Promise.all(herd)).resolves.toEqual(Array(40).fill("v1"));

    await flushMicrotasks();
    expect(loader).toHaveBeenCalledTimes(1);

    load.resolve("v2");
    await vi.waitFor(async () => {
      expect(await cache.get<string>("hot")).toBe("v2");
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
