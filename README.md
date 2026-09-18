# Cacheline

Resume-grade TypeScript caching toolkit: in-memory + optional Redis, singleflight, stampede protection, TTL/jitter, and benchmarks.

Free/local only — Docker Redis optional. No paid APIs.

## Status

**Day 2** is implemented: `getOrSet` with TTL, an in-memory store, singleflight, soft TTL / early refresh (serve stale + background reload), and TTL jitter. Later slices stay in `WEEK_PLAN.md`.

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

## Week plan

See `WEEK_PLAN.md`.
