# Cacheline — weekday slices (credit-light)

## Day 1 — Core cache + singleflight
- GetOrSet API, TTL, in-memory store
- Singleflight / coalesce in-flight loads
- Vitest unit tests

## Day 2 — Stampede protection + jitter
- Soft TTL / early refresh
- TTL jitter
- Tests for thundering herd

## Day 3 — Redis backend (optional) ✅
- docker-compose Redis
- Redis store implementation
- Integration tests skip if Redis down

## Day 4 — Metrics + tiny HTTP demo ✅
- Hit/miss/coalesce counters
- Minimal local demo server using a free public API (JSONPlaceholder) as loader

## Day 5 — Benchmarks + README polish
- Microbench script
- Architecture + resume bullets
