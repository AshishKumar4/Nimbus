export declare function serializeFunction(fn: Function): string;
/**
 * djb2 over a string's UTF-16 code units, as an unsigned 32-bit integer:
 * fast, deterministic, not cryptographic. Behind loader cache keys and peer
 * placement.
 */
export declare function djb2(text: string): number;
/** {@link djb2} of `source` in base 36, for loader cache keys. */
export declare function hashSource(source: string): string;
//# sourceMappingURL=serialize.d.ts.map