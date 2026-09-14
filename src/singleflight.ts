/**
 * Coalesces concurrent work for the same key so only one `fn` runs.
 * Waiters share that in-flight promise (success or failure).
 */
export class Singleflight {
  private readonly inflight = new Map<string, Promise<unknown>>();

  do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const pending: Promise<T> = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.inflight.get(key) === pending) {
          this.inflight.delete(key);
        }
      });

    this.inflight.set(key, pending);
    return pending;
  }
}
