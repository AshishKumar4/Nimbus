/**
 * npm-tarball.ts — tarball extraction + cache-restore payload builder.
 *
 * Phase 2 A'.1 reduced this module to:
 *   - extractTarball / extractTarballFromResponse — streaming gunzip+tar.
 *     Used by the install-batch facet (which holds the bytes inside its
 *     own 128 MiB envelope, not the supervisor's).
 *   - buildCacheRestorePayload — supervisor-side BatchWritePayload
 *     builder for the cached-tarball fast path. Runs only on a cache
 *     hit; the bytes already live in the per-DO npm cache rather than
 *     being fetched off the network.
 *
 * The legacy `fetchWaves` async generator + `buildBatchPayload` builder
 * were removed — they ran in supervisor heap and held tarball bytes long
 * enough to OOM the DO on large installs. The single batch-facet path
 * (src/npm-install-batch-facet.ts) supersedes them.
 */
import type { NpmCache } from './cache.js';
import type { ResolvedPackage, HoistPlan } from './resolver.js';
import type { BatchWritePayload } from '../vfs/sqlite-vfs.js';
export interface FetchedPackage {
    pkg: ResolvedPackage;
    files: Map<string, Uint8Array>;
}
/**
 * Streaming extractor driven by a `Response` body.
 *
 * Pipes `resp.body` through `DecompressionStream('gzip')` (npm tarballs are
 * always gzipped) and walks the tar stream entry-by-entry. Never buffers the
 * full decompressed tarball — peak transient heap is one file's bytes plus a
 * small carry buffer. This is the path used by live installs; the cache
 * restore path (in-memory bytes from SQLite) still uses `extractTarball`.
 *
 * The returned Map is per-file Uint8Arrays, same shape as the legacy
 * extractor so downstream `putTarballFiles` / `buildBatchPayload` don't care.
 * If the response has no body (unusual but possible with some proxies), we
 * fall back to `arrayBuffer()` + `extractTarball` so we still make progress.
 */
export declare function extractTarballFromResponse(resp: Response): Promise<Map<string, Uint8Array>>;
/**
 * Legacy buffered extractor. Kept for code paths that receive a fully-buffered
 * tarball (e.g. the tarball cache restore path, which already stores bytes in
 * SQLite as Uint8Arrays). New install paths use `streamTarEntries` instead.
 */
export declare function extractTarball(tarball: ArrayBuffer): Promise<Map<string, Uint8Array>>;
/**
 * Build a BatchWritePayload from the tarball cache (for packages that were
 * already cached — no fetch needed).
 */
export declare function buildCacheRestorePayload(packages: ResolvedPackage[], hoistPlan: HoistPlan, nodeModulesDir: string, cache: NpmCache): BatchWritePayload;
//# sourceMappingURL=tarball.d.ts.map