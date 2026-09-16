import type { CacheEntry, CacheStore } from "./types.js";

/** Process-local Map store. No persistence across restarts. */
export class MemoryStore implements CacheStore {
  private readonly entries = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: CacheEntry): void {
    this.entries.set(key, entry);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}
