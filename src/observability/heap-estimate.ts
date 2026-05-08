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
 * Workerd (per docs/research/cf-internal-dossier.md §9.2 metrics.h:300)
 * distinguishes five labelled eviction reasons:
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

import { CHUNK_SIZE, LRU_MAX_ENTRIES, SUPERVISOR_HEAP_CEILING_BYTES } from '../constants.js';
import type { DiagCounters } from './diag-counters.js';

/**
 * Five labelled workerd eviction reasons. Surfaced as a constant
 * taxonomy in /api/_diag/memory so any consumer can count observed
 * events against the well-known set.
 *
 * Source: cloudflare/ew/edgeworker metrics.c++:1778-1790 + metrics.h:300.
 * Cross-cited in docs/research/cf-internal-dossier.md §9.2.
 */
export const WORKERD_EVICTION_LABELS = [
  'lru',
  'condemned',
  'inactive',
  'dynamic_worker',
  'dynamic_worker_banned',
] as const;

export type WorkerdEvictionLabel = typeof WORKERD_EVICTION_LABELS[number];

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
}

export interface HeapBreakdown {
  /** Static module bundle + runtime baseline. Constant per build. */
  supervisorBaselineBytes: number;
  /** SqliteVFS LRU cache hot-byte count (sqlite-vfs.ts cache.hotBytes). */
  vfsLruBytes: number;
  /** SqliteVFS in-flight write payload bytes (peak observed). */
  vfsInFlightBytes: number;
  /** Resolver in-flight packument bytes (rough cap = live stubs × last
   *  packument size). Post A'.1 the resolver runs in a facet and this
   *  is always 0; the slot is preserved so a regression that
   *  re-introduces supervisor-side resolution is locatable. */
  resolverInFlightBytes: number;
  /** Pre-bundle slice bytes resident in supervisor heap (peak across
   *  in-flight pool slots × SLICE_CAP_BYTES). Drops to 0 once
   *  A'.2/A'.3 stream the slice through ReadableStream-over-RPC. */
  preBundleSliceBytes: number;
  /** esbuild-wasm bytes resident in supervisor. Phase 2 A'.5 moved
   *  these to env.ASSETS; the slot is 0 by construction now. */
  esbuildResidentBytes: number;
  /**
   * In-flight supervisor RPC payload bytes (Phase 2 A'.2).
   *
   * Sum of bytes claimed by RPC handlers in src/supervisor-rpc.ts
   * between RPC entry and exit — writeBatch / writeBatchStream /
   * putRegistryEntries / R2 cache RPC return values. Tracked by
   * `inFlightRpcPayloadBytes` in src/diag-counters.ts; bumped at
   * RPC entry, debited in `finally`.
   *
   * At idle this is 0. Under load it should stay bounded by the
   * largest single in-flight RPC's payload (~few MiB for writeBatch).
   * Persistent non-zero readings here mean an RPC handler isn't
   * decrementing on its failure path — a leak worth fixing.
   */
  streamingBuffersBytes: number;
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
 * esbuild-wasm bytes resident in supervisor heap.
 *
 * Pre-A'.5: 16 MiB module-scope cache in src/esbuild-wasm-bytes.ts —
 * the decoded ArrayBuffer was held for the lifetime of the supervisor
 * isolate so multiple pool constructions amortised the base64 decode.
 *
 * Post-A'.5: 0. The bytes live in env.ASSETS; src/esbuild-wasm-bytes.ts
 * fetches on demand and the supervisor releases its reference after
 * the LOADER hand-off. There IS a transient ~12 MiB pulse during pool
 * construction, but it's not resident — by the time anyone polls the
 * estimator we're back to zero. The constant captures the resident
 * floor; transient bytes don't show up here.
 */
const ESBUILD_RESIDENT_BYTES = 0;

/**
 * Maximum SqliteVFS LRU footprint (architectural cap). Used as the
 * upper bound for the LRU contribution when the SqliteVFS hasn't been
 * instantiated yet (cacheHotBytes = 0 from the inputs).
 *
 * Defensive — the live cacheHotBytes is the source of truth once the
 * VFS exists. This value is NOT used in production; the estimator
 * receives the live count via VfsHeapInputs.
 */
export const VFS_LRU_MAX_BYTES = LRU_MAX_ENTRIES * CHUNK_SIZE;

/**
 * Estimate resolver in-flight bytes from diag-counters.
 *
 * The resolver in-supervisor path (pre-A'.1) holds packument JSON in
 * memory while parsing. We don't have a "current in-flight bytes"
 * counter directly, but we DO have:
 *   - inFlightPackumentFetches (live count of awaited fetches)
 *   - lastPackumentBytes (size of the most recent packument)
 *
 * Average packument size on real registries is dominated by the largest
 * outliers (lucide-react, framer-motion at ~5 MiB each) so using
 * lastPackumentBytes as a per-fetch upper bound is a reasonable proxy.
 *
 * Caller can also pass an explicit `cumulativeBytesDecoded` snapshot
 * (resolverPath = 'in-supervisor') for a different estimation strategy
 * — but right now the most useful signal is "is the resolver currently
 * holding bytes in supervisor heap or has it moved to a facet?".
 *
 * After A'.1 lands and resolverPath becomes hard-pinned to 'in-facet',
 * this contribution drops to 0 by construction.
 */
export function estimateResolverInFlightBytes(c: DiagCounters): number {
  if (c.resolverPath === 'in-facet') return 0;
  if (c.inFlightPackumentFetches === 0) return 0;
  // Conservative: each in-flight fetch counted at the size of the
  // most recent packument. This OVER-estimates when the in-flight
  // packuments are smaller than lastPackumentBytes (which they
  // probably are — lastPackumentBytes is a worst-of-recent value).
  return c.inFlightPackumentFetches * c.lastPackumentBytes;
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
export function estimatePreBundleSliceBytes(c: DiagCounters): number {
  // Conservative: if the most recent batch attempted >0 specs and the
  // batch hasn't fully completed, assume one slice's worth of bytes
  // are in flight. The 28 MiB constant must stay in lockstep with
  // PRE_BUNDLE_CONCURRENCY × SLICE_CAP_BYTES in npm-installer.ts.
  const SLICE_CAP_BYTES = 28 * 1024 * 1024;
  const PRE_BUNDLE_CONCURRENCY = 1;
  const f = c.preBundleFacet;
  const inFlight = f.attempted - f.bundlesCompleted - f.errors - f.skipped;
  if (inFlight <= 0) return 0;
  return Math.min(inFlight, PRE_BUNDLE_CONCURRENCY) * SLICE_CAP_BYTES;
}

/**
 * Build a heap estimate from runtime counters + VFS inputs.
 *
 * Pure function — no I/O, microsecond cost. Called from the
 * /api/_diag/memory request handler.
 */
export function estimateSupervisorHeap(
  c: DiagCounters,
  vfs: VfsHeapInputs,
): HeapEstimate {
  const breakdown: HeapBreakdown = {
    supervisorBaselineBytes: SUPERVISOR_BASELINE_BYTES,
    vfsLruBytes: vfs.cacheHotBytes,
    vfsInFlightBytes: vfs.inFlightWriteBytes,
    resolverInFlightBytes: estimateResolverInFlightBytes(c),
    preBundleSliceBytes: estimatePreBundleSliceBytes(c),
    esbuildResidentBytes: ESBUILD_RESIDENT_BYTES,
    streamingBuffersBytes: c.inFlightRpcPayloadBytes,
  };

  const estimatedBytes =
    breakdown.supervisorBaselineBytes +
    breakdown.vfsLruBytes +
    breakdown.vfsInFlightBytes +
    breakdown.resolverInFlightBytes +
    breakdown.preBundleSliceBytes +
    breakdown.esbuildResidentBytes +
    breakdown.streamingBuffersBytes;

  const percentOfCeiling = Math.round(
    (estimatedBytes / SUPERVISOR_HEAP_CEILING_BYTES) * 1000,
  ) / 10;

  return {
    estimatedBytes,
    ceilingBytes: SUPERVISOR_HEAP_CEILING_BYTES,
    percentOfCeiling,
    breakdown,
  };
}
