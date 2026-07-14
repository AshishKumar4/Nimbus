/**
 * npm-install-batch-facet.ts — single-facet batch installer.
 *
 * Why this exists
 * ───────────────
 * The previous architecture (src/npm-install-facet.ts + pool.map) spawned
 * ONE dynamic worker per pool slot. With concurrency=4, that's 4 permanent
 * loader entries in workerd's loader cache (each `loader.get(id, …)` call
 * is cached by id and the cache is never released — confirmed in
 * src/parallel/facet-pool.ts:328-348). Combine with:
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
 * Memory plan inside the facet (pLimit=3, 16 MiB flush threshold):
 *   - 3 concurrent tarball pipelines: each holds at most 16 MiB of
 *     pending-flush bytes + 1× tarball-decompress state (~5-10 MiB) +
 *     integrity-hash buffer (compressed tarball size, ~1-3 MiB).
 *   - Peak ≈ 3 × (16 + 10 + 3) = ~87 MiB inside the facet's 128 MiB cap.
 *   - ~40 MiB headroom for V8 + tar-parser closure state.
 *
 * The per-package logic (fetch + integrity-verify + gunzip + tar-parse +
 * writeBatch flush) is identical to src/npm-install-facet.ts — kept
 * inlined here as a closure rather than imported because cloudflare-parallel
 * serializes via fn.toString() and we cannot import from sibling modules
 * across the isolate boundary. If the per-package logic in the legacy
 * facet changes, mirror the change here.
 *
 * Stability invariants (cloudflare-parallel):
 *   - No `this` references.
 *   - No closure capture other than args + preamble names.
 *   - Preamble symbols (streamTarEntries, readableStreamToAsyncIterable,
 *     MAX_FILE_BYTES) referenced via @ts-ignore.
 */
import type { FacetPackageSpec } from './install-facet.js';
export interface InstallBatchSpec {
    /** All packages to install in this batch. ≈456 entries × ~200 B = ~90 KB,
     *  well under workerd's 32 MiB RPC arg cap. */
    packages: FacetPackageSpec[];
    /** Internal pLimit cap for concurrent tarball pipelines.
     *  3 keeps facet heap peak ~87 MiB under the 128 MiB cap.
     *  Lower if pathological packages cause facet OOM in prod. */
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
    /** Counter snapshot at end of batch. Mirrors src/diag-counters.ts shape
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
        writeBatchStream: (stream: ReadableStream<Uint8Array>) => Promise<{
            inodes: number;
            chunks: number;
        }>;
        getCachedTarball?: (name: string, version: string) => Promise<Uint8Array | null | {
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
        putCachedTarball?: (name: string, version: string, bytes: Uint8Array | ArrayBuffer) => Promise<boolean>;
    };
}) => Promise<InstallBatchResult>;
//# sourceMappingURL=install-batch-facet.d.ts.map