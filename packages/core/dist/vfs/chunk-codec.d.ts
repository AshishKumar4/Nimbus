/**
 * How the durable filesystem stores a chunk's bytes: deflated when that pays.
 *
 * A chunk is deflated (raw deflate, level 1, native zlib) and kept that way
 * when the result is at least an eighth smaller, else stored as it is. Source
 * trees and node_modules shrink 2.8-4x, and a DO write costs what it puts on
 * pages, so the smaller row is also the faster write. A chunk's name (its
 * sha256) and size are always of its bytes as written: dedup, manifests,
 * exports and the cold store never see the stored form.
 */
/** `raw` deflated, or null when that does not save at least an eighth of it. */
export declare function deflateChunk(raw: Uint8Array): Uint8Array | null;
/** A deflated chunk's bytes; throws unless they inflate to exactly `size`. */
export declare function inflateChunk(data: Uint8Array, size: number): Uint8Array;
//# sourceMappingURL=chunk-codec.d.ts.map