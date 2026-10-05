/**
 * git/pack/byte-lru.ts — a least-recently-used map bounded by the bytes of its
 * values rather than their number: a delta-base cache holds a few large
 * objects or many small ones in the same budget.
 */
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
    get byteLength(): number;
    get(key: K): V | undefined;
    set(key: K, value: V): void;
    clear(): void;
}
//# sourceMappingURL=byte-lru.d.ts.map