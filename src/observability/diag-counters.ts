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
// CLN-1 (2026-05-11): InstallPhase moved to _shared/install-phase.ts so
// it can't drift between this module and npm/installer.ts again. The
// merged union includes both 'idle' (resting state) and 'lock-check'
// (parsing package-lock.json). See _shared/install-phase.ts for full
// semantics documentation.
export type { InstallPhase } from '../_shared/install-phase.js';
import type { InstallPhase } from '../_shared/install-phase.js';

export type ResolverPhase =
  | 'idle' | 'fetching' | 'parsing' | 'caching' | 'done';

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

const _counters: DiagCounters = {
  installPhase: 'idle',
  resolverPhase: 'idle',
  inFlightPackumentFetches: 0,
  liveResponseStubs: 0,
  inFlightRpcPayloadBytes: 0,
  lastPackumentBytes: 0,
  cumulativePackumentBytesDecoded: 0,
  packumentsDecoded: 0,
  lastPackumentName: '',
  resolverPath: 'unset',
  installFacet: {
    path: 'unset',
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
    lastError: '',
    errorsByModule: {},
  },
  r2: {
    tarballHit: 0,
    tarballMiss: 0,
    packumentHit: 0,
    packumentMiss: 0,
    tarballPutOk: 0,
    tarballPutFail: 0,
    packumentPutOk: 0,
    packumentPutFail: 0,
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
  if (p !== 'resolve') _counters.resolverPhase = 'idle';
}

/** Set the resolver sub-phase. No-op if installPhase isn't 'resolve' to
 *  keep the signal clean — caller paths that bump phase outside the
 *  resolver are a bug worth surfacing rather than silently accepting. */
export function setResolverPhase(p: ResolverPhase): void {
  _counters.resolverPhase = p;
}

/** Indicate which resolver path is in use for the current install. */
export function setResolverPath(p: DiagCounters['resolverPath']): void {
  _counters.resolverPath = p;
}

/** Bump in-flight count. Call before issuing the network fetch. */
export function packumentFetchStart(name: string): void {
  _counters.inFlightPackumentFetches++;
  _counters.liveResponseStubs++;
  _counters.lastPackumentName = name;
}

/** Decrement in-flight count + record bytes. Call after we've read the
 *  body and are about to dispose the stub.
 *
 *  bytesDecoded: the size of the JSON-parse INPUT (i.e. the response
 *  body length). Pass 0 if the fetch failed and we never decoded. */
export function packumentFetchEnd(bytesDecoded: number): void {
  if (_counters.inFlightPackumentFetches > 0) _counters.inFlightPackumentFetches--;
  if (bytesDecoded > 0) {
    _counters.lastPackumentBytes = bytesDecoded;
    _counters.cumulativePackumentBytesDecoded += bytesDecoded;
    _counters.packumentsDecoded++;
  }
}

/** Decrement liveResponseStubs after Symbol.dispose has been called.
 *  Separate from packumentFetchEnd because some failure paths dispose
 *  before they finish reading bytes. */
export function responseStubDisposed(): void {
  if (_counters.liveResponseStubs > 0) _counters.liveResponseStubs--;
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

/** Set the install-fetch path label. Called at fetch-phase entry by
 *  npm-installer once the dispatch decision is known. */
export function setInstallFacetPath(p: DiagCounters['installFacet']['path']): void {
  _counters.installFacet.path = p;
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
 *  batch. Loosing prior-batch errors is fine — they're already aggregated
 *  into `errors` (count); the map is for "which modules failed this
 *  time." */
export function recordPreBundleSummary(s: {
  attempted: number;
  bundlesCompleted: number;
  errors: number;
  skipped: number;
  wasmBootBytes?: number;
  lastError?: string;
  errorsByModule?: Record<string, string>;
}): void {
  _counters.preBundleFacet.attempted += s.attempted;
  _counters.preBundleFacet.bundlesCompleted += s.bundlesCompleted;
  _counters.preBundleFacet.errors += s.errors;
  _counters.preBundleFacet.skipped += s.skipped;
  if (s.wasmBootBytes && _counters.preBundleFacet.wasmBootBytes === 0) {
    _counters.preBundleFacet.wasmBootBytes = s.wasmBootBytes;
  }
  if (s.lastError) {
    // Truncate to keep diag payload bounded.
    _counters.preBundleFacet.lastError = String(s.lastError).slice(0, 200);
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

// ── R2-backed npm cache counters [W4] ──────────────────────────────────
//
// These counter bumps live in the supervisor isolate (called from
// SupervisorRPC.getCachedTarball / getCachedPackument / putCached*).
// The facet itself never imports diag-counters — it sees only the
// SUPERVISOR RPC binding; the bump happens on the supervisor side after
// the RPC method fires.

export function r2TarballHit(): void { _counters.r2.tarballHit++; }
export function r2TarballMiss(): void { _counters.r2.tarballMiss++; }
export function r2PackumentHit(): void { _counters.r2.packumentHit++; }
export function r2PackumentMiss(): void { _counters.r2.packumentMiss++; }
export function r2TarballPutOk(): void { _counters.r2.tarballPutOk++; }
export function r2TarballPutFail(): void { _counters.r2.tarballPutFail++; }
export function r2PackumentPutOk(): void { _counters.r2.packumentPutOk++; }
export function r2PackumentPutFail(): void { _counters.r2.packumentPutFail++; }

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
import {
  recordHit as _cacheRecordHit,
  recordMiss as _cacheRecordMiss,
  type CacheTier,
  type CacheKind,
} from '../_shared/cache-stats.js';

export type CacheStatEvent =
  | { kind: 'hit'; tier: CacheTier; cacheKind: CacheKind; bytes: number }
  | { kind: 'miss'; tier: CacheTier; cacheKind: CacheKind };

export function recordCacheStatEvents(events: readonly unknown[] | undefined): void {
  if (!events || events.length === 0) return;
  const validTiers = new Set<CacheTier>(['L1', 'L2', 'L3', 'L4']);
  const validKinds = new Set<CacheKind>(['tarball', 'packument', 'asset']);
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const e: any = raw;
    if (!validTiers.has(e.tier)) continue;
    if (!validKinds.has(e.cacheKind)) continue;
    if (e.kind === 'hit') {
      const bytes = typeof e.bytes === 'number' && e.bytes > 0 ? e.bytes : 0;
      _cacheRecordHit(e.tier, e.cacheKind, bytes);
    } else if (e.kind === 'miss') {
      _cacheRecordMiss(e.tier, e.cacheKind);
    }
  }
}

/** Reset everything. Used by tests; not called from prod paths. */
export function resetDiagCounters(): void {
  _counters.installPhase = 'idle';
  _counters.resolverPhase = 'idle';
  _counters.inFlightPackumentFetches = 0;
  _counters.liveResponseStubs = 0;
  _counters.inFlightRpcPayloadBytes = 0;
  _counters.lastPackumentBytes = 0;
  _counters.cumulativePackumentBytesDecoded = 0;
  _counters.packumentsDecoded = 0;
  _counters.lastPackumentName = '';
  _counters.resolverPath = 'unset';
  _counters.installFacet = {
    path: 'unset',
    tarballsCompleted: 0,
    cumulativeBytesDecoded: 0,
    peakInFlight: 0,
  };
  _counters.preBundleFacet = {
    attempted: 0,
    bundlesCompleted: 0,
    errors: 0,
    skipped: 0,
    wasmBootBytes: 0,
    lastError: '',
    errorsByModule: {},
  };
  _counters.r2 = {
    tarballHit: 0,
    tarballMiss: 0,
    packumentHit: 0,
    packumentMiss: 0,
    tarballPutOk: 0,
    tarballPutFail: 0,
    packumentPutOk: 0,
    packumentPutFail: 0,
    pipelinedTarballRaceWins: 0,
    pipelinedTarballRaceLosses: 0,
    pipelinedPackumentRaceWins: 0,
    pipelinedPackumentRaceLosses: 0,
  };
}
