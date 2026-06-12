/**
 * LruMap — a bounded, insertion-order LRU keyed map.
 *
 * Uses the standard JS `Map` insertion-order idiom the VFS content cache
 * relies on (sqlite-vfs.ts): a read or write moves the key to the most-
 * recently-used position (delete + re-set), and inserting past capacity
 * evicts the least-recently-used key (`keys().next().value`).
 *
 * Exposes only the `Map` surface its callers use so it can drop in for a
 * raw `Map` without churn: `get`, `set`, `delete`, `has`, `keys`,
 * `clear`, and `size`.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxEntries: number) {
    if (maxEntries <= 0) throw new Error('LruMap maxEntries must be > 0');
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Move to MRU position.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const lru = this.map.keys().next().value;
      if (lru !== undefined) this.map.delete(lru);
    }
    this.map.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}
