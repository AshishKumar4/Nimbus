export declare function serializeFunction(fn: Function): string;
/**
 * djb2 over a string's UTF-16 code units, as an unsigned 32-bit integer:
 * fast, deterministic, not cryptographic. Behind loader cache keys and peer
 * placement.
 */
export declare function djb2(text: string): number;
/** {@link djb2} of `source` in base 36, for loader cache keys. */
export declare function hashSource(source: string): string;
/**
 * A 32-bit hash of every byte of `buffer`, for loader cache keys over
 * multi-MiB wasm images: two multiply-xorshift lanes over its 32-bit words,
 * then the tail bytes, the length and murmur3's finalizer. Not
 * cryptographic. Words are read in the host's byte order; a cache key only
 * has to agree with itself on one host.
 */
export declare function hashBytes(buffer: ArrayBuffer): number;
//# sourceMappingURL=serialize.d.ts.map