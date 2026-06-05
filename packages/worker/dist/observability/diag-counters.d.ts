/**
 * diag-counters.ts — application-level memory + phase observability.
 *
 * Why: workerd's `process.memoryUsage()` returns 0 for all fields inside
 * a Durable Object class context (only dynamic-worker isolates under
 * nodejs_compat get the real implementation). Without a working heap
 * probe we have no way to confirm OOM hypotheses or verify a fix.
 *
 * Replacement: deterministic counters bumped at known allocation sites.
 * Cumulative bytes decoded, in-flight stub counts, and phase markers
 * give us the same operational signal as a heap probe — and they're
 * exact, not estimated.
 *
 * Singleton-per-isolate. Lives at module scope so any code path in the
 * supervisor bundle can write to it (installer, resolver, retry) and
 * the request handler in nimbus-session.ts:/api/_diag/memory can read
 * it. Survives across requests within the same isolate; resets on DO
 * reboot — itself a useful signal (counters at 0 immediately after the
 * banner reprinted = the killed isolate took its state with it).
 */
/**
 * Phase tags surfaced via /api/_diag/memory. Strings are ASCII so
 * humans can grep for them in logs.
 *
 * installPhase tracks the high-level npm-install state machine:
 *   idle → resolve → hoist → diff → fetch → write → link-bins → bundle → done
 *
 * resolverPhase tracks what resolveTree / resolvePackage is doing
 * RIGHT NOW (only meaningful while installPhase === 'resolve'):
 *   idle → fetching → parsing → caching → done
 */
export type { InstallPhase } from '../_shared/install-phase.js';
import type { InstallPhase } from '../_shared/install-phase.js';
export type ResolverPhase = 'idle' | 'fetching' | 'parsing' | 'caching' | 'done';
export interface DiagCounters {
    /** Top-level install phase. */
    installPhase: InstallPhase;
    /** Sub-phase within the resolver. Set only during 'resolve'. */
    resolverPhase: ResolverPhase;
    /** Number of packument fetches currently awaiting a response. */
    inFlightPackumentFetches: number;
    /** Number of RPC Response stubs alive (incremented at fetch entry,
     *  decremented at dispose / explicit drop). Should track close to
     *  inFlightPackumentFetches; a divergence means we're leaking. */
    liveResponseStubs: number;
    /**
     * Sum of payload bytes claimed by RPCs currently in flight on the
     * SUPERVISOR boundary [Phase 2 A'.2].
     *
     * Bumped at RPC entry by `rpcPayloadStart(bytes)` (called from
     * src/supervisor-rpc.ts handlers); debited at exit by
     * `rpcPayloadEnd(bytes)`. Goes back to zero after every RPC settles.
     *
     * The C'.1 heap estimator surfaces this as
     * `breakdown.streamingBuffersBytes` so any RPC path that buffers
     * MORE than the W7 streaming guarantee shows up as supervisor heap
     * pressure rather than disappearing into the bundle baseline.
     *
     * Streamed payloads (writeBatchStream over W7 frames) report -1
     * up-front; we substitute 0 here because the bytes flow with
     * backpressure and the supervisor-resident buffer is bounded by
     * the W7 chunk size (a few KiB), not by the total payload.
     */
    inFlightRpcPayloadBytes: number;
    /** Bytes returned by the most recent packument fetch (Content-Length
     *  if advertised, else final buffer size). Spot indicator for the
     *  current spike. */
    lastPackumentBytes: number;
    /** Cumulative bytes JSON.parse'd from packuments since process start.
     *  THIS IS THE SMOKING GUN: pre-fix we expect this to climb into
     *  hundreds of MB on the supervisor before the crash; post-fix
     *  (resolver moved to facet) we expect this to stay near 0. */
    cumulativePackumentBytesDecoded: number;
    /** Number of packuments fully decoded since process start. */
    packumentsDecoded: number;
    /** Most recent packument name + size — useful for narrowing which
     *  registry entry tripped a spike. */
    lastPackumentName: string;
    /** Whether the resolver-facet path executed for the most recent
     *  install. Phase 2 A'.1 made the facet resolver the single
     *  resolver path — the union narrowed from 3 values to 2.
     *  'unset' before any install runs in the lifetime of the DO; flips
     *  to 'in-facet' on the first install. */
    resolverPath: 'in-facet' | 'unset';
    /** Install-facet counters. Populated by npm-installer after a
     *  successful batch-facet dispatch returns. Confirms the install ran
     *  in the facet (tarballsCompleted > 0) and surfaces the
     *  facet-internal byte count. */
    installFacet: {
        /** Path used for the most recent install fetch phase. Phase 2 A'.1
         *  made batch-facet the single fetch path. */
        path: 'batch-facet' | 'unset';
        /** Number of tarballs the install-batch-facet successfully streamed. */
        tarballsCompleted: number;
        /** Cumulative tarball body bytes the facet decoded (gunzip input). */
        cumulativeBytesDecoded: number;
        /** Peak in-flight tarball pipelines inside the facet at any one moment. */
        peakInFlight: number;
    };
    /** Pre-bundle facet counters. Tracks the fire-and-forget pre-bundle
     *  phase. Aggregates across all dispatches in this DO's lifetime. */
    preBundleFacet: {
        /** Specifiers attempted (queue depth at start of phase). */
        attempted: number;
        /** Bundles that completed successfully (esmCode produced). */
        bundlesCompleted: number;
        /** Bundles that failed (errorText set on PrebundleResult). */
        errors: number;
        /** Bundles skipped before facet dispatch (e.g. slice cap exceeded). */
        skipped: number;
        /** First-call wasm-fetch payload size. 0 until first successful dispatch
         *  records it; stays at first-seen value (RPC returns the same Module
         *  every time, but the cumulativeBytes the FACET reports may grow on
         *  retries). */
        wasmBootBytes: number;
        /** Most recent error message — truncated to keep the diag payload bounded. */
        lastError: string;
        /** Per-module errors from the MOST RECENT pre-bundle batch, keyed by
         *  specifier (e.g. "lucide-react", "framer-motion"). REPLACED on each
         *  recordPreBundleSummary() call so the map is bounded by the batch
         *  size (≤ pending.length, typically <20). lastError is a 1-string
         *  legacy that loses fidelity when multiple modules in one batch
         *  fail — this map is the proper fix.
         *
         *  Example: { "lucide-react": "Worker exceeded memory limit." }
         *
         *  Empty when the most recent batch had zero errors. */
        errorsByModule: Record<string, string>;
    };
    /** R2-backed cross-tenant npm cache counters (W4). All counts are
     *  cumulative since DO-isolate start. Hits drop install latency;
     *  tracking the hit-rate is the smoking gun for whether the W4 plan
     *  is delivering its promised wins. */
    r2: {
        /** Tarball R2 cache hits (bytes returned from R2, integrity-verified
         *  on read by the install facet). */
        tarballHit: number;
        /** Tarball R2 cache misses (R2 returned null OR oversize-bypass). */
        tarballMiss: number;
        /** Packument R2 cache hits — fresh, not expired. */
        packumentHit: number;
        /** Packument R2 cache misses — absent OR expired. */
        packumentMiss: number;
        /** Tarball R2 writes that succeeded. */
        tarballPutOk: number;
        /** Tarball R2 writes that failed (non-fatal, install proceeds). */
        tarballPutFail: number;
        /** Packument R2 writes that succeeded. */
        packumentPutOk: number;
        /** Packument R2 writes that failed (non-fatal). */
        packumentPutFail: number;
        /** Pipelined-RPC race wins for tarballs (R2 came back first; network
         *  was cancelled). */
        pipelinedTarballRaceWins: number;
        /** Pipelined-RPC race losses for tarballs (R2 came back too slow or
         *  empty; network response used). */
        pipelinedTarballRaceLosses: number;
        /** Pipelined-RPC race wins for packuments. */
        pipelinedPackumentRaceWins: number;
        /** Pipelined-RPC race losses for packuments. */
        pipelinedPackumentRaceLosses: number;
    };
}
/** Read a snapshot — caller-side mutations don't affect the singleton. */
export declare function readDiagCounters(): DiagCounters;
/** Set the install phase. */
export declare function setInstallPhase(p: InstallPhase): void;
/** Set the resolver sub-phase. No-op if installPhase isn't 'resolve' to
 *  keep the signal clean — caller paths that bump phase outside the
 *  resolver are a bug worth surfacing rather than silently accepting. */
export declare function setResolverPhase(p: ResolverPhase): void;
/** Indicate which resolver path is in use for the current install. */
export declare function setResolverPath(p: DiagCounters['resolverPath']): void;
/** Bump in-flight count. Call before issuing the network fetch. */
export declare function packumentFetchStart(name: string): void;
/** Decrement in-flight count + record bytes. Call after we've read the
 *  body and are about to dispose the stub.
 *
 *  bytesDecoded: the size of the JSON-parse INPUT (i.e. the response
 *  body length). Pass 0 if the fetch failed and we never decoded. */
export declare function packumentFetchEnd(bytesDecoded: number): void;
/** Decrement liveResponseStubs after Symbol.dispose has been called.
 *  Separate from packumentFetchEnd because some failure paths dispose
 *  before they finish reading bytes. */
export declare function responseStubDisposed(): void;
/**
 * Track an in-flight supervisor RPC payload [Phase 2 A'.2].
 *
 * Call at RPC entry, BEFORE awaiting any work that depends on
 * `payload`. Pair with `rpcPayloadEnd(bytes)` in the matching `finally`
 * so the counter goes back to zero on both success and failure.
 *
 * `bytes` is the supervisor-resident byte cost of the RPC's argument
 * (or return value, whichever is bigger). For structured-clone RPCs
 * this is the size of the cloned payload in bytes.
 *
 * Streamed payloads (ReadableStream-over-RPC) flow with backpressure
 * and the supervisor-resident bound is the chunk size, not the total
 * payload. Pass the chunk-size estimate (typically ≤ 1 MiB) — never
 * the unknown total. -1 is silently coerced to 0 to keep the counter
 * non-negative; callers that don't know the size should call this
 * with 0 explicitly rather than relying on coercion.
 */
export declare function rpcPayloadStart(bytes: number): void;
/**
 * Release an in-flight supervisor RPC payload [Phase 2 A'.2].
 * Pass the same byte count given to the matching `rpcPayloadStart`.
 *
 * Floors at 0 to absorb arithmetic drift (e.g. if a payload-byte
 * counter rounding gave a slightly different number on entry vs.
 * exit). Drift in routine paths should be zero — a non-zero floor
 * hit is a bug worth investigating.
 */
export declare function rpcPayloadEnd(bytes: number): void;
/** Set the install-fetch path label. Called at fetch-phase entry by
 *  npm-installer once the dispatch decision is known. */
export declare function setInstallFacetPath(p: DiagCounters['installFacet']['path']): void;
/** Fold facet-returned counters into the supervisor's diag state.
 *  Called by npm-installer after the batch-facet returns; aggregates
 *  rather than replaces so multiple install runs in the same DO
 *  lifetime accumulate in cumulativeBytesDecoded. */
export declare function recordInstallFacetCounters(c: {
    tarballsCompleted: number;
    cumulativeBytesDecoded: number;
    peakInFlight: number;
}): void;
/** Record pre-bundle phase summary. Aggregates lifetime totals across
 *  all phases run in this DO's lifetime, but REPLACES the
 *  errorsByModule map every call so it reflects only the most recent
 *  batch. Loosing prior-batch errors is fine — they're already aggregated
 *  into `errors` (count); the map is for "which modules failed this
 *  time." */
export declare function recordPreBundleSummary(s: {
    attempted: number;
    bundlesCompleted: number;
    errors: number;
    skipped: number;
    wasmBootBytes?: number;
    lastError?: string;
    errorsByModule?: Record<string, string>;
}): void;
export declare function r2TarballHit(): void;
export declare function r2TarballMiss(): void;
export declare function r2PackumentHit(): void;
export declare function r2PackumentMiss(): void;
export declare function r2TarballPutOk(): void;
export declare function r2TarballPutFail(): void;
export declare function r2PackumentPutOk(): void;
export declare function r2PackumentPutFail(): void;
/** Bump pipelined-RPC race outcome counters. The facet returns these
 *  in its result counters; the supervisor folds them in alongside the
 *  existing installFacet counters. */
export declare function recordR2RaceCounters(c: {
    pipelinedTarballRaceWins: number;
    pipelinedTarballRaceLosses: number;
    pipelinedPackumentRaceWins: number;
    pipelinedPackumentRaceLosses: number;
}): void;
/**
 * cache-obs-2: fold facet-collected per-tier cache events into the
 * DO-side cache-stats singleton. Called from installer.ts after a
 * batch-facet / resolve-facet returns — mirrors recordR2RaceCounters
 * (a wave-1 establish ed pattern where the facet collects metrics in
 * its result and the supervisor folds them in the DO isolate).
 *
 * Each event has shape:
 *   { kind: 'hit', tier: 'L2'|'L3'|'L4', cacheKind: 'tarball'|'packument'|'asset', bytes: number }
 *   { kind: 'miss', tier: ..., cacheKind: ... }
 *
 * Defensively validates each event so a future facet shape mismatch
 * doesn't poison the DO singleton.
 *
 * Imports cache-stats dynamically (the recordHit/recordMiss surface
 * is defined in src/_shared/cache-stats.ts which is off-limits for
 * direct extension in this wave — we only consume it). Static import
 * is fine; the module is already a peer of this one.
 */
import { type CacheTier, type CacheKind } from '../_shared/cache-stats.js';
export type CacheStatEvent = {
    kind: 'hit';
    tier: CacheTier;
    cacheKind: CacheKind;
    bytes: number;
} | {
    kind: 'miss';
    tier: CacheTier;
    cacheKind: CacheKind;
};
export declare function recordCacheStatEvents(events: readonly unknown[] | undefined): void;
/** Reset everything. Used by tests; not called from prod paths. */
export declare function resetDiagCounters(): void;
//# sourceMappingURL=diag-counters.d.ts.map