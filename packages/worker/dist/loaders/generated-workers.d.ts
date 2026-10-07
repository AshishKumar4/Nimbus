/**
 * generated-workers.ts — AUTO-GENERATED. DO NOT EDIT.
 *
 * Produced by scripts/bundle-facet-workers.mjs from:
 *   - @nimbus-sh/core src/_shared/tarball-stream.ts (streaming tar primitives)
 *   - @nimbus-sh/platform src/w7-frame.ts (W7 streaming bulk-write encoder)
 *   - @nimbus-sh/platform src/wave-writer.ts (the W7 wave writer, as an IIFE)
 *   - @nimbus-sh/core src/_shared/esm-resolver.ts (Node's ESM resolver, for the node shims)
 *   - @nimbus-sh/core src/_shared/http2-module.ts (node:http2, for the node shims)
 *   - @nimbus-sh/core src/_shared/node-shim-resolution.ts (resolution and credential rules, for the node shims)
 *
 * Consumed by fabric/isolate-pool.ts callers via the `preamble`
 * option. The preamble is injected at the top of every generated
 * worker module so user functions can reference the exported
 * helpers by name.
 *
 * Tar-stream symbols: parseTarHeader, streamTarEntries,
 *   streamPackageEntries, readableStreamToAsyncIterable, MAX_FILE_BYTES.
 * W7-frame symbols:   encodeWriteBatchStream, decodeWriteBatchStream,
 *   W7_MAGIC, W7_MAX_RECORD_BYTES.
 *
 * Tar size: 4.58 KiB
 * W7 size:  44.95 KiB
 */
export declare const TAR_STREAM_PREAMBLE: string;
export declare const W7_FRAME_PREAMBLE: string;
/** Binds `__nimbusWaveWriter` (createWaveWriter, WaveFailure, …) in the module that splices it. */
export declare const WAVE_WRITER_PREAMBLE: string;
/** Declares `function createEsmResolver(host)`; the node shims call it. */
export declare const ESM_RESOLVER_PREAMBLE: string;
/** Declares `function createHttp2Module(host)`; the node shims call it. */
export declare const HTTP2_MODULE_PREAMBLE: string;
/**
 * Declares resolveExports, resolvePackageEntry, packageSelfReferenceSubpath,
 * DEFAULT_ESM_CONDITIONS, DEFAULT_CJS_CONDITIONS, typescriptFallbackCandidates,
 * TYPESCRIPT_INDEX_CANDIDATES and presentedCredential; the node shims call them.
 */
export declare const NODE_SHIM_RESOLUTION_PREAMBLE: string;
//# sourceMappingURL=generated-workers.d.ts.map