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
 * supervisor bundle can write to it (installer and RPC handlers) and
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
 */
import type { InstallPhase } from './install-phase.js';
export interface DiagCounters {
    /** Top-level install phase. */
    installPhase: InstallPhase;
    /**
     * Sum of payload bytes claimed by RPCs currently in flight on the
     * SUPERVISOR boundary [Phase 2 A'.2].
     *
     * Bumped at RPC entry by `rpcPayloadStart(bytes)` in the DO-side
     * byte-returning handlers in src/session/rpc.ts; debited at exit by
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
    /**
     * Bytes reserved by prefetch-bundle builds currently in flight.
     *
     * `buildPrefetchBundle` accumulates raw VFS file contents into an in-heap
     * bundle object, and used to do so with nothing observing it: the estimator
     * read 9.4 MiB while those bytes were resetting the DO. Each build now takes
     * an `acquireSupervisorAllocation` lease for the budget it may use and bumps
     * this alongside it, so the reservation is ATTRIBUTED to the bundle path
     * rather than landing in `unattributedReservationBytes`.
     *
     * Surfaced as `breakdown.prefetchBundleBytes`. Back to zero between builds.
     */
    prefetchBundleBytes: number;
    /**
     * Bytes retained by the FacetManager's prefetch-bundle LRU right now.
     *
     * Unlike the counter above these bytes persist ACROSS execs — each entry
     * holds the raw bundle plus its serialized source, manifest and metadata.
     * The LRU used to be bounded by entry count alone, which bounded nothing:
     * 16 pi-sized entries exceed the supervisor ceiling several times over. It
     * is now bounded by PREFETCH_CACHE_MAX_BYTES and reports its live total
     * here, so the retained cost is a measurement rather than a cap.
     *
     * Surfaced as `breakdown.prefetchCacheBytes`. A gauge, not a delta.
     */
    prefetchCacheBytes: number;
    /** Install-facet counters. Populated by npm-installer after a
     *  successful batch-facet dispatch returns. Confirms the install ran
     *  in the facet (tarballsCompleted > 0) and surfaces the
     *  facet-internal byte count. */
    installFacet: {
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
        /** Per-module errors from the MOST RECENT pre-bundle batch, keyed by
         *  specifier (e.g. "lucide-react", "framer-motion"). REPLACED on each
         *  recordPreBundleSummary() call so the map is bounded by the batch
         *  size (≤ pending.length, typically <20).
         *
         *  Example: { "lucide-react": "Worker exceeded memory limit." }
         *
         *  Empty when the most recent batch had zero errors. */
        errorsByModule: Record<string, string>;
    };
    /** Pipelined R2 race outcomes. All counts are cumulative since
     *  DO-isolate start. Per-tier cache statistics live in cache-stats. */
    r2: {
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
/**
 * Track an in-flight prefetch-bundle build. Call with the byte reservation the
 * build took from the supervisor allocation budget, and pair with
 * `prefetchBundleEnd` in the matching `finally` so it returns to zero whether
 * the build succeeded or threw.
 */
export declare function prefetchBundleStart(bytes: number): void;
/** Release an in-flight prefetch-bundle reservation. Floors at 0. */
export declare function prefetchBundleEnd(bytes: number): void;
/**
 * Publish the prefetch-bundle LRU's live retained total. A gauge: the cache
 * owns the number and reports it whenever it admits or evicts an entry.
 */
export declare function setPrefetchCacheBytes(bytes: number): void;
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
 *  batch. Losing prior-batch errors is fine — they're already aggregated
 *  into `errors` (count); the map is for "which modules failed this
 *  time." */
export declare function recordPreBundleSummary(s: {
    attempted: number;
    bundlesCompleted: number;
    errors: number;
    skipped: number;
    wasmBootBytes?: number;
    errorsByModule?: Record<string, string>;
}): void;
/** Bump pipelined-RPC race outcome counters. The facet returns these
 *  in its result counters; the supervisor folds them in alongside the
 *  existing installFacet counters. */
export declare function recordR2RaceCounters(c: {
    pipelinedTarballRaceWins: number;
    pipelinedTarballRaceLosses: number;
    pipelinedPackumentRaceWins: number;
    pipelinedPackumentRaceLosses: number;
}): void;
//# sourceMappingURL=diag-counters.d.ts.map