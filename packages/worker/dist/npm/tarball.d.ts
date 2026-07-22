/**
 * npm-tarball.ts — streaming tarball extraction (gunzip + tar).
 *
 * `extractTarball` / `extractTarballFromResponse` walk a gzipped tar stream
 * entry-by-entry, holding at most one file's bytes at a time. Used by the
 * install-batch facet (whose own 128 MiB envelope, not the supervisor's,
 * holds the bytes) and the ruby-gems runtime.
 *
 * The legacy supervisor-resident `fetchWaves` / `buildBatchPayload` and the
 * `buildCacheRestorePayload` fast path were removed — they ran in supervisor
 * heap and held tarball bytes long enough to OOM the DO on large installs.
 * The single batch-facet path (install-batch-facet.ts) supersedes them and
 * consults the shared L2/L3 tarball cache directly.
 */
/**
 * Streaming extractor driven by a `Response` body.
 *
 * Pipes `resp.body` through `DecompressionStream('gzip')` (npm tarballs are
 * always gzipped) and walks the tar stream entry-by-entry. Never buffers the
 * full decompressed tarball — peak transient heap is one file's bytes plus a
 * small carry buffer.
 *
 * The returned Map is per-file Uint8Arrays. If the response has no body
 * (unusual but possible with some proxies), we fall back to `arrayBuffer()`
 * + `extractTarball` so we still make progress.
 */
export declare function extractTarballFromResponse(resp: Response): Promise<Map<string, Uint8Array>>;
/**
 * Legacy buffered extractor. Kept for code paths that receive a fully-buffered
 * tarball (e.g. the tarball cache restore path, which already stores bytes in
 * SQLite as Uint8Arrays). New install paths use `streamTarEntries` instead.
 */
export declare function extractTarball(tarball: ArrayBuffer): Promise<Map<string, Uint8Array>>;
//# sourceMappingURL=tarball.d.ts.map