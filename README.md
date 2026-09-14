# Cacheline

Resume-grade TypeScript caching toolkit: in-memory + optional Redis, singleflight, stampede protection, TTL/jitter, and benchmarks.

Free/local only — Docker Redis optional. No paid APIs.

## Status

**Day 1** is implemented: `getOrSet` with TTL, an in-memory store, and singleflight (coalesce in-flight loads for the same key). Later slices stay in `WEEK_PLAN.md`.

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

## Day 1 usage

```ts
import { createCache } from "cacheline";

const cache = createCache({ defaultTtlMs: 5_000 });

const value = await cache.getOrSet("user:1", async () => {
  // loader runs at most once per key while in flight
  return { id: 1, name: "Ada" };
});
```

Per-call TTL:

```ts
await cache.getOrSet("session", loadSession, { ttlMs: 1_000 });
```

Concurrent `getOrSet` calls for the same key share one loader invocation. After `ttlMs`, the next call loads again. Failures are not cached.

## Week plan

See `WEEK_PLAN.md`.
