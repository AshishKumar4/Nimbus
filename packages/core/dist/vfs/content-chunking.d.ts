/**
 * Content addressing for the durable filesystem: how file bytes become chunks,
 * and what identifies a chunk and a file.
 *
 * A file of at most CHUNK_SIZE bytes is one chunk. A larger file is cut by
 * FastCDC with normalized chunking (Xia et al., USENIX ATC 2016) at 16/32/64
 * KiB, so an edit moves only the cuts near it and identical runs of bytes in
 * different files or versions land on identical chunks. The maximum equals
 * CHUNK_SIZE, which keeps every existing per-row and per-transaction bound.
 *
 * A cut depends only on the bytes from the previous cut to at most CDC_MAX
 * beyond it, so cutting a stream piecewise (ContentCutter) gives exactly the
 * cuts of cutting the whole buffer at once.
 */
export declare const CDC_MIN = 16384;
export declare const CDC_AVG = 32768;
export declare const CDC_MAX = 65536;
/**
 * End offset of the chunk that starts at `start`, given bytes up to `end`.
 * Returns -1 when the answer needs bytes past `end` and `final` is false.
 */
export declare function cdcCut(data: Uint8Array, start: number, end: number, final: boolean): number;
/** Chunk end offsets of a whole buffer: one chunk up to CHUNK_SIZE, FastCDC above. */
export declare function cutContent(data: Uint8Array): number[];
/**
 * Incremental FastCDC over bytes that arrive in pieces. Holds at most CDC_MAX
 * bytes plus the piece being pushed.
 */
export declare class ContentCutter {
    private carry;
    /** Complete chunks the bytes pushed so far determine. */
    push(bytes: Uint8Array): Uint8Array[];
    /** The chunks left once the stream has ended. */
    finish(): Uint8Array[];
    get pending(): number;
}
/** sha256 of one chunk: the chunk's durable identity. */
export declare function chunkHash(bytes: Uint8Array): Uint8Array;
/** Running digest of a manifest: domain ‖ size ‖ chunk hashes in order. */
export declare class ManifestDigest {
    private readonly hash;
    add(chunk: Uint8Array): void;
    digest(size: number): Uint8Array;
}
/** Content key of the empty file. */
export declare const EMPTY_CONTENT_KEY: Uint8Array<ArrayBufferLike>;
/**
 * Lowercase hex. A listing encodes one key per file, so this is on the
 * enumeration's hot path: the native encoder where the runtime has one, else
 * a table (measured 0.03 and 0.17 µs per 32-byte key, against 0.82 for a
 * toString/padStart loop).
 */
export declare function hex(bytes: Uint8Array): string;
//# sourceMappingURL=content-chunking.d.ts.map