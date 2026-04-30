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
export type InstallPhase =
  | 'idle' | 'resolve' | 'hoist' | 'diff'
  | 'fetch' | 'write' | 'link-bins' | 'bundle' | 'done';

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
  /** Whether the resolver-facet path is in use. Set by npm-installer at
   *  resolve-phase entry; surfaces in the diag payload so a repro can
   *  confirm which code path served the request. */
  resolverPath: 'in-supervisor' | 'in-facet' | 'unset';
  /** Install-facet counters. Populated by npm-installer after a
   *  successful batch-facet dispatch returns. Confirms the install ran
   *  in the facet (tarballsCompleted > 0) and surfaces the
   *  facet-internal byte count for the same kind of "smoking gun"
   *  comparison we use for the resolver. */
  installFacet: {
    /** Path used for the most recent install fetch phase. */
    path: 'batch-facet' | 'pool.map' | 'legacy-waves' | 'unset';
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
}

const _counters: DiagCounters = {
  installPhase: 'idle',
  resolverPhase: 'idle',
  inFlightPackumentFetches: 0,
  liveResponseStubs: 0,
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

/** Reset everything. Used by tests; not called from prod paths. */
export function resetDiagCounters(): void {
  _counters.installPhase = 'idle';
  _counters.resolverPhase = 'idle';
  _counters.inFlightPackumentFetches = 0;
  _counters.liveResponseStubs = 0;
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
}
