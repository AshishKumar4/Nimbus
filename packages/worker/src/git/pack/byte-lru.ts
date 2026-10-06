/**
 * git/pack/byte-lru.ts — a least-recently-used map bounded by the bytes of its
 * values rather than their number: a delta-base cache holds a few large
 * objects or many small ones in the same budget.
 */

/**
 * What one entry costs beyond its bytes: the key, the Map entry, the value
 * object and its ArrayBuffer. Charged so many small entries are bounded too:
 * a status after a clone read 16,850 small trees, and an 8 MiB cache counting
 * payload alone held ~17 MiB (SatisfiedTapir's heap profile of next.js).
 */
export const BYTE_LRU_ENTRY_OVERHEAD = 160;

export class ByteLru<K, V extends { byteLength: number }> {
  private readonly map = new Map<K, V>();
  private bytes = 0;

  /** `maxBytes` bounds the sum; a value larger than `maxValueBytes` is never kept. */
  constructor(readonly maxBytes: number, readonly maxValueBytes = maxBytes) {
    if (!(maxBytes > 0)) throw new Error('ByteLru maxBytes must be > 0');
  }

  get size(): number {
    return this.map.size;
  }

  /** Bytes charged: the values' and each entry's overhead. */
  get byteLength(): number {
    return this.bytes;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    const previous = this.map.get(key);
    if (previous !== undefined) {
      this.map.delete(key);
      this.bytes -= previous.byteLength + BYTE_LRU_ENTRY_OVERHEAD;
    }
    if (value.byteLength > this.maxValueBytes) return;
    this.map.set(key, value);
    this.bytes += value.byteLength + BYTE_LRU_ENTRY_OVERHEAD;
    for (const [oldest, evicted] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(oldest);
      this.bytes -= evicted.byteLength + BYTE_LRU_ENTRY_OVERHEAD;
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}
