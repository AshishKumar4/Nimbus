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
export declare class LruMap<K, V> {
    private readonly maxEntries;
    private readonly map;
    constructor(maxEntries: number);
    get size(): number;
    get(key: K): V | undefined;
    has(key: K): boolean;
    set(key: K, value: V): this;
    delete(key: K): boolean;
    clear(): void;
    keys(): IterableIterator<K>;
}
/** Estimated cost of an entry's key, Map node, value object and ArrayBuffer.
 * Charging payload alone leaves a cache of many small entries undercounted. */
export declare const BYTE_LRU_ENTRY_OVERHEAD = 160;
/** A least-recently-used map bounded by its values' bytes, not their count. */
export declare class ByteLru<K, V extends {
    byteLength: number;
}> {
    readonly maxBytes: number;
    readonly maxValueBytes: number;
    private readonly map;
    private bytes;
    /** `maxBytes` bounds the sum; a value larger than `maxValueBytes` is never kept. */
    constructor(maxBytes: number, maxValueBytes?: number);
    get size(): number;
    /** Bytes charged: the values' and each entry's overhead. */
    get byteLength(): number;
    get(key: K): V | undefined;
    set(key: K, value: V): void;
    clear(): void;
}
//# sourceMappingURL=lru-map.d.ts.map