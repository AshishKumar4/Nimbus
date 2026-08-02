/**
 * heap-estimate.ts — deterministic supervisor-heap estimator [C'.1]
 *
 * Why this module exists
 * ──────────────────────
 * `process.memoryUsage()` returns 0 for every field inside a Durable
 * Object class context (only dynamic-worker isolates under nodejs_compat
 * get the real implementation). The previous `readNodeMem` /
 * `sampleMemory` helpers in nimbus-session-diag.ts called it anyway and
 * therefore reported zero forever — useless for verifying memory-
 * containment work in plan §3 Track A'.
 *
 * Replacement: a deterministic estimator that sums the INSTRUMENTED
 * supervisor heap allocation sources — runtime counters that ARE accurate
 * (diag-counters.ts singleton + SqliteVFS.getStats()). Every byte it
 * reports has a named contributor, so a regression in any one component
 * is locatable.
 *
 * `estimatedBytes` is a LOWER BOUND, not a total
 * ─────────────────────────────────────────────
 * Within each instrumented component the estimator over-reports on
 * purpose: components carry a peak-or-current value, in-flight bytes are
 * counted before they are freed, and LRU bytes are the cap rather than the
 * live footprint.
 *
 * Across components it UNDER-reports, because it can only sum what is
 * instrumented. Allocation sites that neither bump a diag counter nor take
 * a lease via `acquireSupervisorAllocation` are invisible to it, and it has
 * no way to infer their size. Observed consequence: the supervisor DO was
 * reset three times under prefetch-bundle construction while this estimator
 * reported a 9.4 MiB baseline and 35 KB of LRU — the bytes that actually
 * killed it were all in sites listed in HEAP_BLIND_SPOTS below.
 *
 * So `estimatedBytes` and `percentOfCeiling` answer "how much of the
 * ceiling do the instrumented sources account for", NOT "how close is the
 * supervisor to being reset". `blindSpots` is returned alongside them so a
 * reader cannot mistake one question for the other. Closing a blind spot
 * means instrumenting it at its own allocation site and adding it to the
 * breakdown — never estimating it from here.
 *
 * Eviction-label taxonomy
 * ───────────────────────
 * Workerd distinguishes five labelled eviction reasons:
 *   - lru                       → memory pressure on the runtime process
 *   - condemned                 → kill (operator / abuse pipeline)
 *   - inactive                  → idle eviction (70-140 s of no traffic)
 *   - dynamic_worker            → per-owner LRU cap (default 50)
 *   - dynamic_worker_banned     → Dice abuse-detection ban
 *
 * Nimbus surfaces the labels here so any tool that reads
 * /api/_diag/memory has a fixed, well-known taxonomy to count against.
 * The actual count of evictions Nimbus has observed lives in the C'.2
 * recovery_event ring, separate from this module.
 */
import type { DiagCounters } from './diag-counters.js';
import { type SupervisorAllocationBudgetStats } from './heavy-alloc-coord.js';
/**
 * Five labelled workerd eviction reasons. Surfaced as a constant
 * taxonomy in /api/_diag/memory so any consumer can count observed
 * events against the well-known set.
 *
 */
export declare const WORKERD_EVICTION_LABELS: readonly ["lru", "condemned", "inactive", "dynamic_worker", "dynamic_worker_banned"];
/**
 * A supervisor allocation site the estimator cannot see.
 *
 * Listing one here is a statement of fact about instrumentation, not a
 * measurement: the site allocates on the supervisor heap without bumping a
 * diag counter or taking an `acquireSupervisorAllocation` lease, so its
 * live size is unknown to this module. Only `capBytes` — the bound the
 * site enforces on itself — is knowable from here.
 */
export interface HeapBlindSpot {
    /** Module-qualified allocation site. */
    source: string;
    /**
     * Upper bound the site enforces per retained item, or null when nothing
     * bounds its total bytes. A null here is the important case: it means no
     * finite worst case can be stated for the supervisor at all.
     */
    capBytes: number | null;
    /** What allocates, and why the estimator cannot observe it. */
    reason: string;
}
/**
 * Supervisor allocation sites known to be unaccounted for.
 *
 * Both entries below are the prefetch-bundle path in facets/manager.ts,
 * which contains no `acquireSupervisorAllocation` call and reports no byte
 * counter. `breakdown.preBundleSliceBytes` does NOT cover them — that
 * component tracks the separate pre-bundle FACET pool via
 * `DiagCounters.preBundleFacet`, and reads 0 while these are at their peak.
 *
 * Closing these means instrumenting them in facets/manager.ts and moving
 * them into HeapBreakdown. Until then they are named here so the gap is
 * visible in /api/_diag/memory instead of being silently absent.
 */
export declare const HEAP_BLIND_SPOTS: readonly HeapBlindSpot[];
/**
 * Supervisor heap snapshot. Components are PEAK-OR-CURRENT bytes from
 * runtime counters; the estimator never calls process.memoryUsage().
 */
export interface HeapEstimate {
    /**
     * Sum of the instrumented components below. Always equals the breakdown
     * sum, and is a LOWER BOUND on supervisor heap — see `blindSpots`.
     */
    estimatedBytes: number;
    /** SUPERVISOR_HEAP_CEILING_BYTES (constant — 64 MiB by design). */
    ceilingBytes: number;
    /**
     * estimatedBytes / ceilingBytes × 100, one decimal place. Shares
     * estimatedBytes' lower-bound caveat: a low value does NOT mean the
     * supervisor has headroom, only that instrumented sources are small.
     */
    percentOfCeiling: number;
    /** Per-source byte attribution for the instrumented sources. */
    breakdown: HeapBreakdown;
    /**
     * Allocation sites this estimate does not cover. Non-empty means
     * `estimatedBytes` cannot be read as a total. See HEAP_BLIND_SPOTS.
     */
    blindSpots: readonly HeapBlindSpot[];
    /**
     * Worst-case bytes the blind spots could add, or null when any of them
     * is unbounded — in which case no finite worst case exists and only
     * direct instrumentation can answer the headroom question.
     */
    blindSpotCeilingBytes: number | null;
    /**
     * Shared transient-allocation budget occupancy. Named contributors overlap
     * this total; any otherwise-unattributed occupancy is included in
     * breakdown.unattributedReservationBytes.
     */
    allocationBudget: SupervisorAllocationBudgetStats;
}
export interface HeapBreakdown {
    /** Static module bundle + runtime baseline. Constant per build. */
    supervisorBaselineBytes: number;
    /** SqliteVFS LRU cache hot-byte count (sqlite-vfs.ts cache.hotBytes). */
    vfsLruBytes: number;
    /** SqliteVFS current logical retained write payload bytes. */
    vfsInFlightBytes: number;
    /** Pre-bundle slice bytes resident in supervisor heap (peak across
     *  in-flight pool slots × SLICE_CAP_BYTES). Drops to 0 once
     *  A'.2/A'.3 stream the slice through ReadableStream-over-RPC. */
    preBundleSliceBytes: number;
    /**
     * In-flight supervisor RPC payload bytes (Phase 2 A'.2).
     *
     * Sum of bytes claimed by DO-side byte-returning filesystem RPC handlers
     * between payload allocation and exit. Tracked by
     * `inFlightRpcPayloadBytes` in src/observability/diag-counters.ts; bumped
     * after shared-budget admission and debited in `finally`.
     *
     * At idle this is 0. Under load it should stay bounded by the
     * shared allocation budget.
     * Persistent non-zero readings here mean an RPC handler isn't
     * decrementing on its failure path — a leak worth fixing.
     */
    streamingBuffersBytes: number;
    /**
     * Shared-budget occupancy not already represented by the named transient
     * counters. This covers full-budget owners and keeps cross-DO module-local
     * reservations visible without double-counting read/write payloads.
     */
    unattributedReservationBytes: number;
}
/**
 * Inputs the estimator needs from the SqliteVFS layer. Kept narrow
 * (just the two fields we actually consume) to avoid a circular import
 * between observability/ and the VFS module.
 */
export interface VfsHeapInputs {
    /** SqliteVFS.getStats().cache.hotBytes — actual LRU memory in use. */
    cacheHotBytes: number;
    /** Current sum of in-flight write payloads (or 0 if none). */
    inFlightWriteBytes: number;
}
/**
 * Estimate pre-bundle slice bytes resident in the supervisor heap.
 *
 * Pre A'.2: the supervisor builds the slice in heap (up to
 * SLICE_CAP_BYTES = 28 MiB per concurrent slot) before passing to the
 * pre-bundle facet. With PRE_BUNDLE_CONCURRENCY = 1 the cap is 28 MiB.
 *
 * Diag counters track pre-bundle attempts/completions but not
 * in-flight slice bytes specifically. Until A'.2 streams the slice,
 * we treat the slice as PRESENT in supervisor heap iff the pre-bundle
 * phase is active AND a slot is in flight (no completion yet for the
 * current attempted count).
 *
 * After A'.2 lands the slice flows via ReadableStream-over-RPC and
 * supervisor never holds the bytes — this contribution drops to 0.
 */
export declare function estimatePreBundleSliceBytes(c: DiagCounters): number;
/**
 * Build a heap estimate from runtime counters + VFS inputs.
 *
 * Deterministic and I/O-free. Called from the /api/_diag/memory request
 * handler; the allocation-budget snapshot is process-local state.
 */
export declare function estimateSupervisorHeap(c: DiagCounters, vfs: VfsHeapInputs): HeapEstimate;
//# sourceMappingURL=heap-estimate.d.ts.map