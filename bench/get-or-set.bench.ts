import { afterAll, beforeAll, bench, describe } from "vitest";
import { createCache, type Cacheline } from "../src/index.js";

/**
 * In-memory microbench. No network and no Redis.
 *
 * - hit path: repeated getOrSet on one warm key (loader must not run)
 * - miss path: a new key every call (lookup, load, store)
 * - singleflight: 32 concurrent getOrSet calls share one loader
 *
 * One reported op is one bench iteration. The singleflight op is the
 * whole 32-caller batch, not one waiter.
 */
const cacheOptions = { defaultTtlMs: 60_000, jitterRatio: 0 } as const;
const sample = { time: 500, warmupTime: 100 } as const;
const coalesceWaiters = 32;

function freshCache(): Cacheline {
  return createCache(cacheOptions);
}

describe("in-memory getOrSet", () => {
  const hitCache = freshCache();
  let hitLoads = 0;

  beforeAll(async () => {
    await hitCache.getOrSet("hit", () => {
      hitLoads += 1;
      return 1;
    });

    const flight = freshCache();
    let loads = 0;
    await Promise.all(
      Array.from({ length: coalesceWaiters }, () =>
        flight.getOrSet("coalesce-check", () => {
          loads += 1;
          return "ok";
        }),
      ),
    );
    if (loads !== 1) {
      throw new Error(`singleflight preflight expected 1 load, got ${loads}`);
    }
  });

  bench(
    "hit path (warm key)",
    async () => {
      await hitCache.getOrSet("hit", () => {
        hitLoads += 1;
        return 1;
      });
    },
    sample,
  );

  const missCache = freshCache();
  let missSeq = 0;
  bench(
    "miss path (unique key)",
    async () => {
      const key = `miss:${missSeq++}`;
      await missCache.getOrSet(key, () => missSeq);
    },
    sample,
  );

  const flightCache = freshCache();
  let flightSeq = 0;
  bench(
    `singleflight (${coalesceWaiters} concurrent callers)`,
    async () => {
      const key = `flight:${flightSeq++}`;
      const load = () => key;
      await Promise.all(
        Array.from({ length: coalesceWaiters }, () =>
          flightCache.getOrSet(key, load),
        ),
      );
    },
    sample,
  );

  afterAll(() => {
    if (hitLoads !== 1) {
      throw new Error(`hit path ran the loader ${hitLoads} times`);
    }
  });
});
