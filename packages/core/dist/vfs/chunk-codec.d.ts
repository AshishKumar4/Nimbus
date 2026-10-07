/**
 * How the durable filesystem may store a chunk's bytes: as written, or
 * deflated (raw deflate, native zlib). A chunk's name (its sha256) and size
 * are always of its bytes as written, so dedup, manifests, exports and the
 * cold store never see the stored form; only the one read of a stored row
 * (SqliteVFS.heldChunkBytes) inflates it.
 *
 * This release reads deflated chunks and writes none. The release that
 * deflates them in the background follows it, so code rolled back one
 * release still reads everything stored.
 */
/** A deflated chunk's bytes; throws unless they inflate to exactly `size`. */
export declare function inflateChunk(data: Uint8Array, size: number): Uint8Array;
//# sourceMappingURL=chunk-codec.d.ts.map