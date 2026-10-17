/**
 * hex.ts — bytes as unseparated lowercase hex: the spelling of every content
 * key, digest, object id and token Nimbus writes. It imports nothing, so a
 * compiled guest body or a facet bundle takes it along; a hash is its
 * caller's, as is any width, offset or truncation.
 */
/**
 * Each byte value's two hex digits: for a reader that spells a window of a
 * larger buffer in place (git's object ids in a pack or a tree), where V8
 * encodes a view natively slower than this table walks it.
 */
export declare const HEX_BYTE: readonly string[];
/**
 * Lowercase hex of `bytes`. A listing encodes one key per file, so this is
 * on the enumeration's hot path: the native encoder where the runtime has
 * one, else a table (measured 0.03 and 0.17 µs per 32-byte key, against
 * 0.82 for a toString/padStart loop).
 */
export declare function bytesToHex(bytes: Uint8Array): string;
//# sourceMappingURL=hex.d.ts.map