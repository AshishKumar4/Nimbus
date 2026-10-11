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
export class LruMap {
    maxEntries;
    map = new Map();
    constructor(maxEntries) {
        this.maxEntries = maxEntries;
        if (maxEntries <= 0)
            throw new Error('LruMap maxEntries must be > 0');
    }
    get size() {
        return this.map.size;
    }
    get(key) {
        const value = this.map.get(key);
        if (value === undefined)
            return undefined;
        // Move to MRU position.
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }
    has(key) {
        return this.map.has(key);
    }
    set(key, value) {
        if (this.map.has(key)) {
            this.map.delete(key);
        }
        else if (this.map.size >= this.maxEntries) {
            const lru = this.map.keys().next().value;
            if (lru !== undefined)
                this.map.delete(lru);
        }
        this.map.set(key, value);
        return this;
    }
    delete(key) {
        return this.map.delete(key);
    }
    clear() {
        this.map.clear();
    }
    keys() {
        return this.map.keys();
    }
}
/** Estimated cost of an entry's key, Map node, value object and ArrayBuffer.
 * Charging payload alone leaves a cache of many small entries undercounted. */
export const BYTE_LRU_ENTRY_OVERHEAD = 160;
/** A least-recently-used map bounded by its values' bytes, not their count. */
export class ByteLru {
    maxBytes;
    maxValueBytes;
    map = new Map();
    bytes = 0;
    /** `maxBytes` bounds the sum; a value larger than `maxValueBytes` is never kept. */
    constructor(maxBytes, maxValueBytes = maxBytes) {
        this.maxBytes = maxBytes;
        this.maxValueBytes = maxValueBytes;
        if (!(maxBytes > 0))
            throw new Error('ByteLru maxBytes must be > 0');
    }
    get size() { return this.map.size; }
    /** Bytes charged: the values' and each entry's overhead. */
    get byteLength() { return this.bytes; }
    get(key) {
        const value = this.map.get(key);
        if (value === undefined)
            return undefined;
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }
    set(key, value) {
        const previous = this.map.get(key);
        if (previous !== undefined) {
            this.map.delete(key);
            this.bytes -= previous.byteLength + BYTE_LRU_ENTRY_OVERHEAD;
        }
        if (value.byteLength > this.maxValueBytes)
            return;
        this.map.set(key, value);
        this.bytes += value.byteLength + BYTE_LRU_ENTRY_OVERHEAD;
        for (const [oldest, evicted] of this.map) {
            if (this.bytes <= this.maxBytes)
                break;
            this.map.delete(oldest);
            this.bytes -= evicted.byteLength + BYTE_LRU_ENTRY_OVERHEAD;
        }
    }
    clear() {
        this.map.clear();
        this.bytes = 0;
    }
}
