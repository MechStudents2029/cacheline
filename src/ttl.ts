/** Symmetric jitter: `ttlMs * (1 + (random * 2 - 1) * jitterRatio)`. */
export function applyJitter(
  ttlMs: number,
  jitterRatio: number,
  random: () => number,
): number {
  if (jitterRatio === 0) {
    return ttlMs;
  }
  const factor = 1 + (random() * 2 - 1) * jitterRatio;
  const jittered = ttlMs * factor;
  if (!Number.isFinite(jittered) || jittered <= 0) {
    return ttlMs;
  }
  return jittered;
}

export function resolveJitterRatio(jitterRatio: number | undefined): number {
  const value = jitterRatio ?? 0;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("jitterRatio must be between 0 and 1 inclusive");
  }
  return value;
}

export function resolveSoftTtlRatio(
  softTtlRatio: number | undefined,
): number | undefined {
  if (softTtlRatio === undefined) {
    return undefined;
  }
  if (!Number.isFinite(softTtlRatio) || softTtlRatio <= 0 || softTtlRatio > 1) {
    throw new Error("softTtlRatio must be in (0, 1]");
  }
  return softTtlRatio;
}

export function resolveEarlyRefreshMs(
  earlyRefreshMs: number | undefined,
): number | undefined {
  if (earlyRefreshMs === undefined) {
    return undefined;
  }
  if (!Number.isFinite(earlyRefreshMs) || earlyRefreshMs < 0) {
    throw new Error("earlyRefreshMs must be a non-negative finite number");
  }
  return earlyRefreshMs;
}

/**
 * Soft expiry: serve stale + background refresh when `now >= softExpiresAt`
 * but still before hard `expiresAt`.
 *
 * `earlyRefreshMs` (remaining-TTL window) wins over `softTtlRatio` when both
 * are set.
 */
export function computeSoftExpiresAt(
  now: number,
  expiresAt: number,
  jitteredTtlMs: number,
  earlyRefreshMs: number | undefined,
  softTtlRatio: number | undefined,
): number {
  let softExpiresAt = expiresAt;
  if (earlyRefreshMs !== undefined && earlyRefreshMs > 0) {
    softExpiresAt = expiresAt - earlyRefreshMs;
  } else if (softTtlRatio !== undefined && softTtlRatio < 1) {
    softExpiresAt = now + jitteredTtlMs * softTtlRatio;
  }

  if (softExpiresAt >= expiresAt) {
    return expiresAt;
  }
  if (softExpiresAt < now) {
    return now;
  }
  return softExpiresAt;
}
