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
export declare const BYTE_LRU_ENTRY_OVERHEAD = 160;
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
//# sourceMappingURL=byte-lru.d.ts.map