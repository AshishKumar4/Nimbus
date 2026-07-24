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

import {
  PRE_BUNDLE_CONCURRENCY,
  PRE_BUNDLE_SLICE_CAP_BYTES,
  SUPERVISOR_HEAP_CEILING_BYTES,
} from '../constants.js';
import type { DiagCounters } from './diag-counters.js';
import {
  readSupervisorAllocationBudget,
  type SupervisorAllocationBudgetStats,
} from './heavy-alloc-coord.js';

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
] as const;

/**
 * Supervisor heap snapshot. Components are PEAK-OR-CURRENT bytes from
 * runtime counters; the estimator never calls process.memoryUsage().
 */
export interface HeapEstimate {
  /** Sum of all components below. Always equals breakdown sum. */
  estimatedBytes: number;
  /** SUPERVISOR_HEAP_CEILING_BYTES (constant — 64 MiB by design). */
  ceilingBytes: number;
  /** estimatedBytes / ceilingBytes × 100, one decimal place. */
  percentOfCeiling: number;
  /** Per-source byte attribution. */
  breakdown: HeapBreakdown;
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
export function estimatePreBundleSliceBytes(c: DiagCounters): number {
  // Conservative: if the most recent batch attempted >0 specs and the
  // batch hasn't fully completed, assume one slice's worth of bytes
  // are in flight.
  const f = c.preBundleFacet;
  const inFlight = f.attempted - f.bundlesCompleted - f.errors - f.skipped;
  if (inFlight <= 0) return 0;
  return Math.min(inFlight, PRE_BUNDLE_CONCURRENCY) * PRE_BUNDLE_SLICE_CAP_BYTES;
}

/**
 * Build a heap estimate from runtime counters + VFS inputs.
 *
 * Deterministic and I/O-free. Called from the /api/_diag/memory request
 * handler; the allocation-budget snapshot is process-local state.
 */
export function estimateSupervisorHeap(
  c: DiagCounters,
  vfs: VfsHeapInputs,
): HeapEstimate {
  const allocationBudget = readSupervisorAllocationBudget();
  const preBundleSliceBytes = estimatePreBundleSliceBytes(c);
  const transientAttributedBytes =
    vfs.inFlightWriteBytes +
    preBundleSliceBytes +
    c.inFlightRpcPayloadBytes;
  const breakdown: HeapBreakdown = {
    supervisorBaselineBytes: SUPERVISOR_BASELINE_BYTES,
    vfsLruBytes: vfs.cacheHotBytes,
    vfsInFlightBytes: vfs.inFlightWriteBytes,
    preBundleSliceBytes,
    streamingBuffersBytes: c.inFlightRpcPayloadBytes,
    unattributedReservationBytes: Math.max(
      0,
      allocationBudget.current - transientAttributedBytes,
    ),
  };

  const estimatedBytes =
    breakdown.supervisorBaselineBytes +
    breakdown.vfsLruBytes +
    breakdown.vfsInFlightBytes +
    breakdown.preBundleSliceBytes +
    breakdown.streamingBuffersBytes +
    breakdown.unattributedReservationBytes;

  const percentOfCeiling = Math.round(
    (estimatedBytes / SUPERVISOR_HEAP_CEILING_BYTES) * 1000,
  ) / 10;

  return {
    estimatedBytes,
    ceilingBytes: SUPERVISOR_HEAP_CEILING_BYTES,
    percentOfCeiling,
    breakdown,
    allocationBudget,
  };
}
