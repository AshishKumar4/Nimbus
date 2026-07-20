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
 * Replacement: a deterministic estimator that sums KNOWN supervisor heap
 * allocation sources from runtime counters that ARE accurate
 * (diag-counters.ts singleton + SqliteVFS.getStats()). Every byte has a
 * named contributor; a regression in any one component is locatable.
 *
 * The estimator is INTENTIONALLY conservative: each component reports a
 * peak-or-current value, and the total may overestimate (in-flight bytes
 * are counted before they're freed; LRU bytes are the cap, not always
 * the current footprint). Better to over-report than under-report when
 * the alternative is the zero-everywhere status quo.
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
import { PRE_BUNDLE_CONCURRENCY, PRE_BUNDLE_SLICE_CAP_BYTES, SUPERVISOR_HEAP_CEILING_BYTES, } from '../constants.js';
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
 * Pure function — no I/O, microsecond cost. Called from the
 * /api/_diag/memory request handler.
 */
export function estimateSupervisorHeap(c, vfs) {
    const breakdown = {
        supervisorBaselineBytes: SUPERVISOR_BASELINE_BYTES,
        vfsLruBytes: vfs.cacheHotBytes,
        vfsInFlightBytes: vfs.inFlightWriteBytes,
        preBundleSliceBytes: estimatePreBundleSliceBytes(c),
        streamingBuffersBytes: c.inFlightRpcPayloadBytes,
    };
    const estimatedBytes = breakdown.supervisorBaselineBytes +
        breakdown.vfsLruBytes +
        breakdown.vfsInFlightBytes +
        breakdown.preBundleSliceBytes +
        breakdown.streamingBuffersBytes;
    const percentOfCeiling = Math.round((estimatedBytes / SUPERVISOR_HEAP_CEILING_BYTES) * 1000) / 10;
    return {
        estimatedBytes,
        ceilingBytes: SUPERVISOR_HEAP_CEILING_BYTES,
        percentOfCeiling,
        breakdown,
    };
}
