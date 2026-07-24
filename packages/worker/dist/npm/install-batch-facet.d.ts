/**
 * npm-install-batch-facet.ts — single-facet batch installer.
 *
 * Why this exists
 * ───────────────
 * The previous per-package pool.map architecture spawned
 * ONE dynamic worker per pool slot. With concurrency=4, that's 4 permanent
 * loader entries in workerd's loader cache (each `loader.get(id, …)` call
 * is cached by id and the cache is never released — confirmed in
 * src/loaders/loader-pool.ts). Combine with:
 *   - resolver-facet pool: 1 loader entry
 *   - fetch-proxy: 1 loader entry
 *   - pre-bundle pool: 1 effective entry
 *   - install pool.map: 4 entries
 * = 7 concurrent dynamic workers, tripping workerd's per-DO cap with
 * "Too many concurrent dynamic workers" the moment install-pool tries
 * to spawn its 4th slot.
 *
 * The fix: ONE facet for the whole install batch. The facet receives
 * the full FacetPackageSpec[] and loops internally with pLimit(3),
 * producing 1 loader entry instead of 4. Same architectural shape as
 * src/npm-resolve-facet.ts — proven to work in production (commit 9194998).
 *
 * The shared producer wave pre-flushes before 4 MiB or 128 paths. One
 * oversize file may occupy a wave by itself; the supervisor's weighted
 * credit pool and transaction builder remain the authoritative hard bounds.
 *
 * The per-package logic (fetch + integrity-verify + gunzip + tar-parse +
 * writeBatch flush) stays in this function because cloudflare-parallel
 * serializes it via fn.toString() and cannot import sibling modules across
 * the isolate boundary.
 *
 * Stability invariants (cloudflare-parallel):
 *   - No `this` references.
 *   - No closure capture other than args + preamble names.
 *   - Preamble symbols (streamTarEntries, readableStreamToAsyncIterable,
 *     MAX_FILE_BYTES) referenced via @ts-ignore.
 */
import type { FacetPackageSpec } from './install-facet.js';
import type { WriteBatchStreamResult } from '../vfs/sqlite-vfs.js';
export interface InstallBatchSpec {
    /** All packages to install in this batch. ≈456 entries × ~200 B = ~90 KB,
     *  well under workerd's 32 MiB RPC arg cap. */
    packages: FacetPackageSpec[];
    /** Internal pLimit cap for concurrent tarball download/decompression pipelines. */
    concurrency: number;
}
export interface InstallBatchPerPackage {
    name: string;
    version: string;
    fileCount: number;
    bytesWritten: number;
    elapsed: number;
    warnings: string[];
    /** When set, the package failed; caller surfaces this in install log. */
    errorText?: string;
}
export interface InstallBatchResult {
    /** One entry per input spec, in input order. */
    perPackage: InstallBatchPerPackage[];
    /** Wall-clock ms inside the facet (whole batch). */
    elapsed: number;
    /** Counter snapshot at end of batch. Mirrors src/observability/diag-counters.ts shape
     *  for the install-facet subset (commit 3 surfaces these in /api/_diag/memory). */
    facetCounters: {
        tarballsCompleted: number;
        cumulativeBytesDecoded: number;
        peakInFlight: number;
        /** W4: pipelined-RPC race outcomes for tarballs. Folded into the
         *  supervisor's diag.r2.pipelinedTarballRace* counters via
         *  recordR2RaceCounters() in npm-installer. */
        pipelinedTarballRaceWins: number;
        pipelinedTarballRaceLosses: number;
    };
    /**
     * cache-obs-2: per-tier cache events captured during this batch.
     *
     * Each entry records a single L2/L3/L4 hit-or-miss observed when
     * fetching a tarball. L2/L3 events flow up from the supervisor RPC
     * return values (getCachedTarball.events); L4 events are pushed
     * directly by the facet after a successful registry fetch.
     *
     * Folded into the DO-side cache-stats singleton by installer.ts via
     * recordCacheStatEvents — same pattern as recordR2RaceCounters.
     */
    cacheStatEvents: Array<{
        kind: 'hit';
        tier: 'L2' | 'L3' | 'L4';
        cacheKind: 'tarball';
        bytes: number;
    } | {
        kind: 'miss';
        tier: 'L2' | 'L3' | 'L4';
        cacheKind: 'tarball';
    }>;
}
export declare const installPackagesInFacet: (batch: InstallBatchSpec, env: {
    SUPERVISOR: {
        writeBatchStream: (stream: ReadableStream<Uint8Array>) => Promise<WriteBatchStreamResult>;
        getCachedTarball?: (integrity: string) => Promise<{
            bytes: Uint8Array | null;
            events: Array<{
                kind: "hit";
                tier: string;
                cacheKind: string;
                bytes: number;
            } | {
                kind: "miss";
                tier: string;
                cacheKind: string;
            }>;
        }>;
        putCachedTarball?: (integrity: string, bytes: Uint8Array | ArrayBuffer) => Promise<boolean>;
    };
}) => Promise<InstallBatchResult>;
//# sourceMappingURL=install-batch-facet.d.ts.map