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
const _counters = {
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
export function readDiagCounters() {
    return { ..._counters };
}
/** Set the install phase. */
export function setInstallPhase(p) {
    _counters.installPhase = p;
    if (p !== 'resolve')
        _counters.resolverPhase = 'idle';
}
/** Set the resolver sub-phase. No-op if installPhase isn't 'resolve' to
 *  keep the signal clean — caller paths that bump phase outside the
 *  resolver are a bug worth surfacing rather than silently accepting. */
export function setResolverPhase(p) {
    _counters.resolverPhase = p;
}
/** Indicate which resolver path is in use for the current install. */
export function setResolverPath(p) {
    _counters.resolverPath = p;
}
/** Bump in-flight count. Call before issuing the network fetch. */
export function packumentFetchStart(name) {
    _counters.inFlightPackumentFetches++;
    _counters.liveResponseStubs++;
    _counters.lastPackumentName = name;
}
/** Decrement in-flight count + record bytes. Call after we've read the
 *  body and are about to dispose the stub.
 *
 *  bytesDecoded: the size of the JSON-parse INPUT (i.e. the response
 *  body length). Pass 0 if the fetch failed and we never decoded. */
export function packumentFetchEnd(bytesDecoded) {
    if (_counters.inFlightPackumentFetches > 0)
        _counters.inFlightPackumentFetches--;
    if (bytesDecoded > 0) {
        _counters.lastPackumentBytes = bytesDecoded;
        _counters.cumulativePackumentBytesDecoded += bytesDecoded;
        _counters.packumentsDecoded++;
    }
}
/** Decrement liveResponseStubs after Symbol.dispose has been called.
 *  Separate from packumentFetchEnd because some failure paths dispose
 *  before they finish reading bytes. */
export function responseStubDisposed() {
    if (_counters.liveResponseStubs > 0)
        _counters.liveResponseStubs--;
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
export function rpcPayloadStart(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0)
        return;
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
export function rpcPayloadEnd(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0)
        return;
    _counters.inFlightRpcPayloadBytes -= n;
    if (_counters.inFlightRpcPayloadBytes < 0) {
        _counters.inFlightRpcPayloadBytes = 0;
    }
}
/** Set the install-fetch path label. Called at fetch-phase entry by
 *  npm-installer once the dispatch decision is known. */
export function setInstallFacetPath(p) {
    _counters.installFacet.path = p;
}
/** Fold facet-returned counters into the supervisor's diag state.
 *  Called by npm-installer after the batch-facet returns; aggregates
 *  rather than replaces so multiple install runs in the same DO
 *  lifetime accumulate in cumulativeBytesDecoded. */
export function recordInstallFacetCounters(c) {
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
export function recordPreBundleSummary(s) {
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
        const trimmed = {};
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
export function r2TarballHit() { _counters.r2.tarballHit++; }
export function r2TarballMiss() { _counters.r2.tarballMiss++; }
export function r2PackumentHit() { _counters.r2.packumentHit++; }
export function r2PackumentMiss() { _counters.r2.packumentMiss++; }
export function r2TarballPutOk() { _counters.r2.tarballPutOk++; }
export function r2TarballPutFail() { _counters.r2.tarballPutFail++; }
export function r2PackumentPutOk() { _counters.r2.packumentPutOk++; }
export function r2PackumentPutFail() { _counters.r2.packumentPutFail++; }
/** Bump pipelined-RPC race outcome counters. The facet returns these
 *  in its result counters; the supervisor folds them in alongside the
 *  existing installFacet counters. */
export function recordR2RaceCounters(c) {
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
import { recordHit as _cacheRecordHit, recordMiss as _cacheRecordMiss, } from '../_shared/cache-stats.js';
export function recordCacheStatEvents(events) {
    if (!events || events.length === 0)
        return;
    const validTiers = new Set(['L1', 'L2', 'L3', 'L4']);
    const validKinds = new Set(['tarball', 'packument', 'asset']);
    for (const raw of events) {
        if (!raw || typeof raw !== 'object')
            continue;
        const e = raw;
        if (!validTiers.has(e.tier))
            continue;
        if (!validKinds.has(e.cacheKind))
            continue;
        if (e.kind === 'hit') {
            const bytes = typeof e.bytes === 'number' && e.bytes > 0 ? e.bytes : 0;
            _cacheRecordHit(e.tier, e.cacheKind, bytes);
        }
        else if (e.kind === 'miss') {
            _cacheRecordMiss(e.tier, e.cacheKind);
        }
    }
}
/** Reset everything. Used by tests; not called from prod paths. */
export function resetDiagCounters() {
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
