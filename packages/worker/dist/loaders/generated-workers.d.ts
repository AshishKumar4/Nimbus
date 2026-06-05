/**
 * generated-workers.ts — AUTO-GENERATED. DO NOT EDIT.
 *
 * Produced by scripts/bundle-facet-workers.mjs from:
 *   - src/npm/tarball-stream.ts (streaming tar primitives)
 *   - src/_shared/w7-frame.ts   (W7 streaming bulk-write encoder)
 *
 * Consumed by src/loaders/loader-pool.ts callers via the `preamble`
 * option. The preamble is injected at the top of every generated
 * worker module so user functions can reference the exported
 * helpers by name.
 *
 * Tar-stream symbols: parseTarHeader, streamTarEntries,
 *   readableStreamToAsyncIterable, MAX_FILE_BYTES.
 * W7-frame symbols:   encodeWriteBatchStream, decodeWriteBatchStream,
 *   W7_MAGIC, W7_TRAILER.
 *
 * Tar size: 3.84 KiB
 * W7 size:  7.78 KiB
 */
export declare const TAR_STREAM_PREAMBLE: string;
export declare const TAR_STREAM_PREAMBLE_SIZE: number;
export declare const W7_FRAME_PREAMBLE: string;
export declare const W7_FRAME_PREAMBLE_SIZE: number;
//# sourceMappingURL=generated-workers.d.ts.map