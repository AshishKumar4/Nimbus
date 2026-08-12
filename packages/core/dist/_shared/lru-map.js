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
