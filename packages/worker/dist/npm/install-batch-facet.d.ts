/**
 * npm-install-batch-facet.ts — single-facet batch installer.
 *
 * What this is
 * ────────────
 * One install shard: a facet that receives a FacetPackageSpec[] and loops
 * internally with pLimit(3), so a shard costs one Dynamic Worker however
 * many packages it holds. The installer's Fanout runs the shards on the
 * session's Dynamic Worker headroom, or across sibling DOs when there are
 * more shards than that.
 *
 * The shard writes through one wave writer (@nimbus-sh/platform
 * wave-writer.ts), which cuts waves at W7's path and byte bounds; the
 * supervisor's weighted credit pool and transaction builder remain the
 * authoritative hard bounds.
 *
 * The per-package logic (fetch + integrity-verify + gunzip + tar-parse +
 * writeBatch flush) stays in this function because cloudflare-parallel
 * serializes it via fn.toString() and cannot import sibling modules across
 * the isolate boundary.
 *
 * Stability invariants (cloudflare-parallel):
 *   - No `this` references.
 *   - No closure capture other than args + preamble names.
 *   - Preamble symbols (streamPackageEntries, streamTarEntries,
 *     readableStreamToAsyncIterable, MAX_FILE_BYTES) referenced via
 *     @ts-ignore; __nimbusWaveWriter declared below.
 *   - The install preamble's functions (retryingRegistryFetch,
 *     strongestSriEntry, sriDigestOf, sriDigestsEqual) are imported, never
 *     declared as globals: the preamble embeds each by its own source, and
 *     an import makes this function name it by the same identifier, whatever
 *     the Worker's bundler calls it. A global of that name would make the
 *     bundler rename the module's function away from it (`retryingRegistryFetch2`),
 *     and the facet would call a name its preamble never defines.
 */
import type { FacetPackageSpec } from './install-facet.js';
import type { CacheStatEvent } from '@nimbus-sh/core/_shared/cache-stats.js';
import type { WriteBatchStreamResult } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { WaveFence } from '@nimbus-sh/platform/wave-writer.js';
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
    /** The spec's identity: one version may land at two directories. Absent from pre-placement shards. */
    pkgDir?: string;
    fileCount: number;
    bytesWritten: number;
    elapsed: number;
    warnings: string[];
    /** When set, the package failed; caller surfaces this in install log. */
    errorText?: string;
    /**
     * Which tier served this tarball, and how long acquiring it took. The
     * supervisor reports both verbatim in its `npm http` lines, so they must
     * stay measurements — absent when the tarball was never acquired.
     */
    tarballSource?: 'cache' | 'registry';
    tarballElapsedMs?: number;
}
export interface InstallBatchResult {
    /** One entry per input spec, in input order. */
    perPackage: InstallBatchPerPackage[];
    /** Wall-clock ms inside the facet (whole batch). */
    elapsed: number;
    /** Counter snapshot at end of batch. Mirrors @nimbus-sh/platform/diag-counters.js shape
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
        /** Longest wait on the R2 leg in this shard, and how many registry
         *  requests the shard issued alongside those waits. Separates cache-tier
         *  latency from registry latency, and says how much of the speculative
         *  network work the cache tier made redundant. */
        r2WaitMsMax: number;
        speculativeFetches: number;
        /** Write waves this shard published, and the ms its writes waited for
         *  the wave in flight to publish: time the shard's tar pipelines were
         *  stopped on writing — the term that separates write cost from
         *  download cost. */
        sharedWaves: number;
        sharedWaveMs: number;
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
    cacheStatEvents: Array<CacheStatEvent & {
        cacheKind: 'tarball';
    }>;
}
export declare const installPackagesInFacet: (batch: InstallBatchSpec, env: {
    SUPERVISOR: {
        writeBatchStream: (stream: ReadableStream<Uint8Array>, fence?: WaveFence) => Promise<WriteBatchStreamResult>;
        openWaveWriter?: () => Promise<string | null>;
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