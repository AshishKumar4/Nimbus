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
// CLN-1 (2026-05-11): InstallPhase moved to _shared/install-phase.ts so
// it can't drift between this module and npm/installer.ts again. The
// merged union includes both 'idle' (resting state) and 'lock-check'
// (parsing package-lock.json). See _shared/install-phase.ts for full
// semantics documentation.
import type { InstallPhase } from '../_shared/install-phase.js';

export interface DiagCounters {
  /** Top-level install phase. */
  installPhase: InstallPhase;
  /**
   * Sum of payload bytes claimed by RPCs currently in flight on the
   * SUPERVISOR boundary [Phase 2 A'.2].
   *
   * Bumped at RPC entry by `rpcPayloadStart(bytes)` (called from
   * src/session/supervisor-rpc.ts handlers); debited at exit by
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

const _counters: DiagCounters = {
  installPhase: 'idle',
  inFlightRpcPayloadBytes: 0,
  installFacet: {
    tarballsCompleted: 0,
    cumulativeBytesDecoded: 0,
    peakInFlight: 0,
  },
  preBundleFacet: {
    attempted: 0,
    bundlesCompleted: 0,
    errors: 0,
    skipped: 0,
    wasmBootBytes: 0,
    errorsByModule: {},
  },
  r2: {
    pipelinedTarballRaceWins: 0,
    pipelinedTarballRaceLosses: 0,
    pipelinedPackumentRaceWins: 0,
    pipelinedPackumentRaceLosses: 0,
  },
};

/** Read a snapshot — caller-side mutations don't affect the singleton. */
export function readDiagCounters(): DiagCounters {
  return { ..._counters };
}

/** Set the install phase. */
export function setInstallPhase(p: InstallPhase): void {
  _counters.installPhase = p;
}

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
export function rpcPayloadStart(bytes: number): void {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return;
  _counters.inFlightRpcPayloadBytes += n;
}

/**
 * Release an in-flight supervisor RPC payload [Phase 2 A'.2].
 * Pass the same byte count given to the matching `rpcPayloadStart`.
 *
 * Floors at 0 to absorb arithmetic drift (e.g. if a payload-byte
 * counter rounding gave a slightly different number on entry vs.
 * exit). Drift in routine paths should be zero — a non-zero floor
 * hit is a bug worth investigating.
 */
export function rpcPayloadEnd(bytes: number): void {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return;
  _counters.inFlightRpcPayloadBytes -= n;
  if (_counters.inFlightRpcPayloadBytes < 0) {
    _counters.inFlightRpcPayloadBytes = 0;
  }
}

/** Fold facet-returned counters into the supervisor's diag state.
 *  Called by npm-installer after the batch-facet returns; aggregates
 *  rather than replaces so multiple install runs in the same DO
 *  lifetime accumulate in cumulativeBytesDecoded. */
export function recordInstallFacetCounters(c: {
  tarballsCompleted: number;
  cumulativeBytesDecoded: number;
  peakInFlight: number;
}): void {
  _counters.installFacet.tarballsCompleted += c.tarballsCompleted;
  _counters.installFacet.cumulativeBytesDecoded += c.cumulativeBytesDecoded;
  if (c.peakInFlight > _counters.installFacet.peakInFlight) {
    _counters.installFacet.peakInFlight = c.peakInFlight;
  }
}

/** Record pre-bundle phase summary. Aggregates lifetime totals across
 *  all phases run in this DO's lifetime, but REPLACES the
 *  errorsByModule map every call so it reflects only the most recent
 *  batch. Losing prior-batch errors is fine — they're already aggregated
 *  into `errors` (count); the map is for "which modules failed this
 *  time." */
export function recordPreBundleSummary(s: {
  attempted: number;
  bundlesCompleted: number;
  errors: number;
  skipped: number;
  wasmBootBytes?: number;
  errorsByModule?: Record<string, string>;
}): void {
  _counters.preBundleFacet.attempted += s.attempted;
  _counters.preBundleFacet.bundlesCompleted += s.bundlesCompleted;
  _counters.preBundleFacet.errors += s.errors;
  _counters.preBundleFacet.skipped += s.skipped;
  if (s.wasmBootBytes && _counters.preBundleFacet.wasmBootBytes === 0) {
    _counters.preBundleFacet.wasmBootBytes = s.wasmBootBytes;
  }
  // Replace (not merge) so we capture only the most recent batch.
  // Bounded by batch size; truncate each value to 200 chars.
  if (s.errorsByModule) {
    const trimmed: Record<string, string> = {};
    for (const [name, msg] of Object.entries(s.errorsByModule)) {
      trimmed[name] = String(msg).slice(0, 200);
    }
    _counters.preBundleFacet.errorsByModule = trimmed;
  }
}

/** Bump pipelined-RPC race outcome counters. The facet returns these
 *  in its result counters; the supervisor folds them in alongside the
 *  existing installFacet counters. */
export function recordR2RaceCounters(c: {
  pipelinedTarballRaceWins: number;
  pipelinedTarballRaceLosses: number;
  pipelinedPackumentRaceWins: number;
  pipelinedPackumentRaceLosses: number;
}): void {
  _counters.r2.pipelinedTarballRaceWins += c.pipelinedTarballRaceWins;
  _counters.r2.pipelinedTarballRaceLosses += c.pipelinedTarballRaceLosses;
  _counters.r2.pipelinedPackumentRaceWins += c.pipelinedPackumentRaceWins;
  _counters.r2.pipelinedPackumentRaceLosses += c.pipelinedPackumentRaceLosses;
}

/**
 * cache-obs-2: fold facet-collected per-tier cache events into the
 * DO-side cache-stats singleton. Called from installer.ts after a
 * batch-facet / resolve-facet returns — mirrors recordR2RaceCounters
 * (the facet collects metrics in its result and the supervisor folds
 * them into the DO isolate).
 *
 * Each event has shape:
 *   { kind: 'hit', tier: 'L2'|'L3'|'L4', cacheKind: 'tarball'|'packument'|'asset', bytes: number }
 *   { kind: 'miss', tier: ..., cacheKind: ... }
 *
 * The recordHit/recordMiss surface is defined in
 * src/_shared/cache-stats.ts.
 */
import {
  recordHit as _cacheRecordHit,
  recordMiss as _cacheRecordMiss,
  type CacheTier,
  type CacheKind,
} from '../_shared/cache-stats.js';

export type CacheStatEvent =
  | { kind: 'hit'; tier: CacheTier; cacheKind: CacheKind; bytes: number }
  | { kind: 'miss'; tier: CacheTier; cacheKind: CacheKind };

export function recordCacheStatEvents(events: readonly CacheStatEvent[] | undefined): void {
  if (!events || events.length === 0) return;
  for (const e of events) {
    if (e.kind === 'hit') {
      _cacheRecordHit(e.tier, e.cacheKind, e.bytes);
    } else {
      _cacheRecordMiss(e.tier, e.cacheKind);
    }
  }
}
