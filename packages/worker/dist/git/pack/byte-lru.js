/**
 * git/pack/byte-lru.ts — a least-recently-used map bounded by the bytes of its
 * values rather than their number: a delta-base cache holds a few large
 * objects or many small ones in the same budget.
 */
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
    get size() {
        return this.map.size;
    }
    get byteLength() {
        return this.bytes;
    }
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
            this.bytes -= previous.byteLength;
        }
        if (value.byteLength > this.maxValueBytes)
            return;
        this.map.set(key, value);
        this.bytes += value.byteLength;
        for (const [oldest, evicted] of this.map) {
            if (this.bytes <= this.maxBytes)
                break;
            this.map.delete(oldest);
            this.bytes -= evicted.byteLength;
        }
    }
    clear() {
        this.map.clear();
        this.bytes = 0;
    }
}
