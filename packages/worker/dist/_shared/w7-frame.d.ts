/**
 * w7-frame.ts — Wire protocol for streaming bulk-write payloads
 * from facet to supervisor over RPC, bypassing the 32 MiB
 * structured-clone cap.
 *
 * Frame format (W7 wire protocol v1):
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ MAGIC: 4 bytes — 'NW7\x01'  (Nimbus W7 v1)             │
 *   │ HDR_LEN: 4 bytes uint32-LE — length of header JSON      │
 *   │ HDR_JSON: HDR_LEN bytes UTF-8 JSON                      │
 *   │   { inodes: BatchInodeEntry[], deletePaths?: string[],  │
 *   │     chunkCount: number }                                │
 *   │ For each chunk (chunkCount times):                       │
 *   │   PATH_LEN: 4 bytes uint32-LE                            │
 *   │   PATH_BYTES: PATH_LEN bytes UTF-8                       │
 *   │   CHUNK_ID:  4 bytes uint32-LE                           │
 *   │   DATA_LEN:  4 bytes uint32-LE                            │
 *   │   DATA:      DATA_LEN bytes raw                            │
 *   │ TRAILER: 4 bytes — 'NEND'                                │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Why a custom frame and not CBOR / protobuf:
 *   - We control both ends; no schema-evolution constraint.
 *   - The whole point is byte-counted streaming with type: 'bytes'.
 *   - Adding a transport dep would bloat the facet preamble.
 *
 * Contract per Cloudflare Workers RPC docs
 * (https://developers.cloudflare.com/workers/runtime-apis/rpc/):
 *
 *   - Only byte-oriented streams (`type: 'bytes'`) traverse RPC.
 *   - Ownership transfers — sender cannot read after sending.
 *   - Flow control is automatic on the byte-stream.
 *
 * The encoder uses `type: 'bytes'` so the resulting stream is
 * byob-readable, which is the precise requirement for RPC transit.
 */
import type { BatchInodeEntry, BatchChunkEntry, BatchWritePayload } from '../vfs/sqlite-vfs.js';
/** Magic bytes 'NW7\x01' — start of every W7 frame.
 *  Not Object.freeze'd: typed-array storage isn't a configurable property,
 *  so freezing throws on any later byte-write. We rely on internal
 *  discipline + .slice() at every emission point. */
export declare const W7_MAGIC: Uint8Array<ArrayBuffer>;
/** Trailer 'NEND' — sanity terminator. Same freeze caveat applies. */
export declare const W7_TRAILER: Uint8Array<ArrayBuffer>;
/** Diagnostics — peak in-flight bytes resident inside any active encoder
 *  queue since last reset. Used by the heap-peak probe to verify the
 *  ≤ 30 MiB acceptance gate. */
export declare function _peakInFlightBytes(): number;
/** Diagnostics — reset both peak and current counters. Intended for
 *  test isolation between scenarios. */
export declare function _resetPeakInFlightBytes(): void;
/**
 * Encode a BatchWritePayload as a byte-oriented ReadableStream.
 *
 * Returns a `ReadableStream<Uint8Array>` with `type: 'bytes'` (BYOB
 * readable, RPC-transferable). The stream:
 *   1. Emits MAGIC.
 *   2. Emits HDR_LEN + HDR_JSON encoding inode metadata, deletePaths,
 *      and chunkCount.
 *   3. Emits each chunk record (PATH_LEN, PATH, CHUNK_ID, DATA_LEN, DATA).
 *   4. Emits TRAILER.
 *   5. Closes.
 *
 * Backpressure: the source uses `pull()` — the encoder produces the
 * NEXT chunk only when the consumer has drained the queue below the
 * HWM. Module-level `_currentInFlight` tracks queue residency for the
 * heap-peak probe.
 */
export declare function encodeWriteBatchStream(payload: BatchWritePayload): ReadableStream<Uint8Array>;
/**
 * Decode a W7 stream into a structured handle:
 *   - `inodes` and `deletePaths` are read eagerly (the header arrives
 *     in the first frame; metadata is small).
 *   - `chunkIter` is an AsyncIterable that yields `BatchChunkEntry`
 *     items one at a time, lazily, as bytes arrive.
 *
 * The chunk iterator is resumable but NOT seekable. The caller must
 * iterate it linearly. Closing the iterator early is permitted (the
 * underlying reader is released).
 *
 * Errors propagate:
 *   - Magic mismatch → rejects on the returned promise.
 *   - Truncated header → rejects on the returned promise.
 *   - Truncated chunk record → the iterator throws the error.
 *   - Source error mid-stream → the iterator throws the error.
 */
export declare function decodeWriteBatchStream(stream: ReadableStream<Uint8Array>): Promise<{
    inodes: BatchInodeEntry[];
    chunkIter: AsyncIterable<BatchChunkEntry>;
    deletePaths?: string[];
}>;
//# sourceMappingURL=w7-frame.d.ts.map