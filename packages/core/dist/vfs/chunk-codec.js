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
import { inflateRawSync } from 'node:zlib';
/** A deflated chunk's bytes; throws unless they inflate to exactly `size`. */
export function inflateChunk(data, size) {
    const raw = inflateRawSync(data, { maxOutputLength: size + 1 });
    if (raw.byteLength !== size)
        throw new Error(`inflates to ${raw.byteLength} bytes, not ${size}`);
    return raw.byteOffset === 0 && raw.buffer.byteLength === size
        ? new Uint8Array(raw.buffer, 0, size)
        : new Uint8Array(raw);
}
