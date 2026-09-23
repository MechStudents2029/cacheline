# Cacheline

Resume-grade TypeScript caching toolkit: in-memory + optional Redis, singleflight, stampede protection, TTL/jitter, and benchmarks.

Free/local only — Docker Redis optional. No paid APIs.

## Status

**Day 5** completes the week plan: GetOrSet, soft TTL and jitter, optional Redis, hit/miss/coalesce metrics, a JSONPlaceholder HTTP demo, and an in-memory microbench. In-memory remains the default.

## Resume bullets

- Built a TypeScript GetOrSet cache with a pluggable store (in-memory `Map` by default, optional Redis) and an injectable clock and RNG so tests stay deterministic.
- Coalesced concurrent misses with singleflight so a stampede on one key runs the loader once and shares the result.
- Added soft TTL (serve stale, refresh in the background) and TTL jitter so readers stay unblocked and expirations do not line up.
- Exposed hit, miss, and coalesce counters, plus a local HTTP demo that caches the public JSONPlaceholder API (no key).
- Covered the core paths with Vitest, including Redis integration tests that skip when Redis is down, and an in-memory microbench (`npm run bench`).

## Setup

```bash
npm install
```

## Tests

```bash
npm test
```

Typecheck / emit:

```bash
npm run build
```

Watch mode: `npm run test:watch`.

## Benchmarks

In-memory only. No network and no Redis.

```bash
npm run bench
```

Prints ops/sec and per-op timings (ms) for three `getOrSet` cases:

- **Hit path** — a warm key; the loader does not run
- **Miss path** — a new key each call (lookup, load, and store)
- **Singleflight** — 32 concurrent callers on one key share a single loader (one reported op is that whole batch)

## Usage

```ts
import { createCache } from "cacheline";

const cache = createCache({
  defaultTtlMs: 5_000,
  // After 80% of TTL, serve the cached value and refresh in the background.
  softTtlRatio: 0.8,
  // Spread expiry ±10% so many keys do not stampede at once.
  jitterRatio: 0.1,
});

const value = await cache.getOrSet("user:1", async () => {
  // loader runs at most once per key while in flight
  return { id: 1, name: "Ada" };
});
```

Per-call TTL / early-refresh window:

```ts
await cache.getOrSet("session", loadSession, { ttlMs: 1_000 });
await cache.getOrSet("feed", loadFeed, { ttlMs: 2_000, earlyRefreshMs: 400 });
```

Concurrent `getOrSet` calls for the same key share one loader invocation (singleflight), including a thundering herd after hard expiry. In the soft-TTL window, callers get the stale value immediately and one background refresh runs. Failures are not cached; a failed background refresh keeps the stale entry until hard TTL.

## Architecture

`createCache` / `Cacheline` is the public API. The pieces below sit behind it.

- **Stores.** `CacheStore` is `get` / `set` / `delete`. `MemoryStore` (default) is a process-local `Map`. `RedisStore` JSON-serializes the same entry and is optional.
- **Singleflight.** In-flight loads are keyed. The caller that starts the load is a miss; joiners are coalesced and await the same promise. A failed load is not stored, so the next call retries.
- **Soft TTL and jitter.** Hard `expiresAt` drops the entry. Inside the soft window the stale value returns immediately and one refresh runs in the background. Jitter spreads hard expiry by `jitterRatio` (default `0`, so expiry stays exact unless you opt in).
- **Metrics.** `metrics()` snapshots `hits`, `misses`, and `coalesced`. `get` does not move them. `resetMetrics()` zeroes the counters.

## Metrics

`cache.metrics()` returns a snapshot of counters updated by `getOrSet`:

- `hits` — a fresh or soft-stale value was served
- `misses` — no live entry; this caller started the loader
- `coalesced` — no live entry; this caller waited on an in-flight load

`get` does not move the counters. `resetMetrics()` zeroes them.

```ts
const snapshot = cache.metrics();
// { hits: 1, misses: 1, coalesced: 2 }
```

## HTTP demo

```bash
npm run demo
```

Then, in another shell:

```bash
curl -s http://127.0.0.1:3000/posts/1
curl -s http://127.0.0.1:3000/metrics
```

`GET /posts/:id` caches a fetch of `https://jsonplaceholder.typicode.com/posts/:id` (public, no API key) for 15 seconds. Repeat an id to see a hit; send concurrent requests for the same id to see `coalesced`. `GET /metrics` returns the counters. Override the port with `PORT`.

## Optional Redis

In-memory is the default. To persist across processes, pass a Redis-backed store (JSON-serializable values). Use local Docker Redis only:

```bash
docker compose up -d
```

```ts
import Redis from "ioredis";
import { Cacheline, RedisStore } from "cacheline";

const redis = new Redis(process.env.CACHELINE_REDIS_URL ?? "redis://127.0.0.1:6379");
const cache = new Cacheline({
  store: new RedisStore(redis),
  defaultTtlMs: 5_000,
});
```

`ioredis` is a test/dev dependency, not required for the in-memory path. Redis integration tests run with `npm test` and skip cleanly when nothing is listening on `CACHELINE_REDIS_URL` (default `redis://127.0.0.1:6379`).

## Week plan

See `WEEK_PLAN.md`. Days 1–5 are complete.
