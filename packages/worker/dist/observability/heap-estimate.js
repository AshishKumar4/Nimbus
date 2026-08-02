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
import { BUNDLE_MAX_ENCODED_BYTES, PRE_BUNDLE_CONCURRENCY, PRE_BUNDLE_SLICE_CAP_BYTES, SUPERVISOR_HEAP_CEILING_BYTES, VFS_BUNDLE_MAX_BYTES, } from '../constants.js';
import { readSupervisorAllocationBudget, } from './heavy-alloc-coord.js';
/**
 * Five labelled workerd eviction reasons. Surfaced as a constant
 * taxonomy in /api/_diag/memory so any consumer can count observed
 * events against the well-known set.
 *
 */
export const WORKERD_EVICTION_LABELS = [
    'lru',
    'condemned',
    'inactive',
    'dynamic_worker',
    'dynamic_worker_banned',
];
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
export const HEAP_BLIND_SPOTS = [
    {
        source: 'facets/manager.ts:buildPrefetchBundle',
        capBytes: VFS_BUNDLE_MAX_BYTES,
        reason: 'Accumulates raw VFS file contents into an in-heap bundle object on every '
            + 'foreground exec. Bounded only by a function-local budgetState counter that '
            + 'is never reported anywhere.',
    },
    {
        source: 'facets/manager.ts:prefetchBundleCache',
        capBytes: null,
        reason: 'Retains up to PREFETCH_CACHE_MAX (16) FacetVfsState entries ACROSS execs, each '
            + 'holding both the raw bundle and its serialized source plus manifest/metadata '
            + `JSON (~${Math.round((VFS_BUNDLE_MAX_BYTES + BUNDLE_MAX_ENCODED_BYTES) / (1024 * 1024))} MiB `
            + 'per entry at the caps). The LRU is bounded by ENTRY COUNT, not by bytes, so no '
            + 'finite byte cap exists — 16 entries at the caps exceed the supervisor ceiling '
            + 'many times over.',
    },
];
// ── Architectural constants for non-counter contributors ────────────────
//
// Each constant below has a comment explaining the source-of-truth and
// when it is expected to change (typically: when a Track A' wave lands).
// They are NOT runtime-measured because the underlying values aren't
// observable from JS — they're properties of the worker bundle itself.
/**
 * Static supervisor baseline. The compiled worker bundle resident in V8
 * isolate memory: module sources, class definitions, top-level imports,
 * lookup tables.
 *
 * Phase 2 A'.5 dropped the 16 MiB esbuild-wasm base64 string from the
 * generated module (it now lives in env.ASSETS), shrinking the worker
 * bundle by ~21 MiB UTF-16-resident. Empirical baseline post-A'.5 is
 * ~9 MiB (verified via the heap-estimator probe + bundle size).
 *
 * This is constant across a deploy. A bundle-size shrink (removing an
 * unused dependency, splitting another big constant out to assets)
 * would lower this further.
 */
const SUPERVISOR_BASELINE_BYTES = 9 * 1024 * 1024;
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
export function estimatePreBundleSliceBytes(c) {
    // Conservative: if the most recent batch attempted >0 specs and the
    // batch hasn't fully completed, assume one slice's worth of bytes
    // are in flight.
    const f = c.preBundleFacet;
    const inFlight = f.attempted - f.bundlesCompleted - f.errors - f.skipped;
    if (inFlight <= 0)
        return 0;
    return Math.min(inFlight, PRE_BUNDLE_CONCURRENCY) * PRE_BUNDLE_SLICE_CAP_BYTES;
}
/**
 * Build a heap estimate from runtime counters + VFS inputs.
 *
 * Deterministic and I/O-free. Called from the /api/_diag/memory request
 * handler; the allocation-budget snapshot is process-local state.
 */
export function estimateSupervisorHeap(c, vfs) {
    const allocationBudget = readSupervisorAllocationBudget();
    const preBundleSliceBytes = estimatePreBundleSliceBytes(c);
    const transientAttributedBytes = vfs.inFlightWriteBytes +
        preBundleSliceBytes +
        c.inFlightRpcPayloadBytes;
    const breakdown = {
        supervisorBaselineBytes: SUPERVISOR_BASELINE_BYTES,
        vfsLruBytes: vfs.cacheHotBytes,
        vfsInFlightBytes: vfs.inFlightWriteBytes,
        preBundleSliceBytes,
        streamingBuffersBytes: c.inFlightRpcPayloadBytes,
        unattributedReservationBytes: Math.max(0, allocationBudget.current - transientAttributedBytes),
    };
    const estimatedBytes = breakdown.supervisorBaselineBytes +
        breakdown.vfsLruBytes +
        breakdown.vfsInFlightBytes +
        breakdown.preBundleSliceBytes +
        breakdown.streamingBuffersBytes +
        breakdown.unattributedReservationBytes;
    const percentOfCeiling = Math.round((estimatedBytes / SUPERVISOR_HEAP_CEILING_BYTES) * 1000) / 10;
    return {
        estimatedBytes,
        ceilingBytes: SUPERVISOR_HEAP_CEILING_BYTES,
        percentOfCeiling,
        breakdown,
        blindSpots: HEAP_BLIND_SPOTS,
        blindSpotCeilingBytes: HEAP_BLIND_SPOTS.some((s) => s.capBytes === null)
            ? null
            : HEAP_BLIND_SPOTS.reduce((sum, s) => sum + (s.capBytes ?? 0), 0),
        allocationBudget,
    };
}
