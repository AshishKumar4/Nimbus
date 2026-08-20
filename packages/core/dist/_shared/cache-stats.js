/**
 * cache-stats.ts — Per-tier hit/miss/bytes counters for the npm cache stack.
 *
 * Purpose
 * ───────
 * The supervisor (and its facets) make cache lookups at four tiers:
 *
 *   L1 — per-DO SQLite (NpmCache)                    ~1 ms / file
 *   L2 — caches.default (per-colo)                   ~50-500 µs hit
 *   L3 — R2 (cross-tenant global)                    ~30-100 ms regional
 *   L4 — registry.npmjs.org origin                   ~100-300 ms cross-region
 *
 * Pre-cache metrics support: hit/miss counters lived in
 * @nimbus-sh/platform/diag-counters.js but only tracked the RPC-call
 * boundary, not per-tier. Those flat counters have since been removed.
 *
 * This module adds per-tier × per-kind counters. SAME singleton-per-
 * isolate pattern as diag-counters.ts so any supervisor code path can
 * write to it and `/api/_diag/cache` reads it back.
 *
 * Why a separate module instead of extending diag-counters.ts:
 *   - Avoids touching diag-counters.ts (other waves may extend that
 *     file's R2 race counters; keeping these orthogonal makes rebases
 *     trivial).
 *   - The new shape (Tier × Kind grid) is structurally different from
 *     diag-counters' flat r2.* shape. Mixing them in one type would
 *     create awkward conditional types.
 *   - The new counters are exposed at /api/_diag/cache; diag-counters
 *     is exposed at /api/_diag/memory. Separate endpoints, separate
 *     modules.
 *
 * Lives in src/_shared/ so anyone (supervisor + future facet code) can
 * import it without crossing the npm/, runtime/, facets/ boundaries
 * that have wave-owners.
 */
const TIERS = ['L1', 'L2', 'L3', 'L4'];
const KINDS = ['tarball', 'packument', 'asset'];
function makeEmptyGrid() {
    const grid = {};
    for (const tier of TIERS) {
        grid[tier] = {};
        for (const kind of KINDS) {
            grid[tier][kind] = { hits: 0, misses: 0, bytes: 0 };
        }
    }
    return grid;
}
/**
 * Module-scoped singleton. Lives for the lifetime of the isolate.
 *
 * Workerd may evict the isolate at any time (memory pressure, idle
 * shutdown, code update); when that happens, counters reset to zero
 * on the next request — itself diagnostic signal: counters all-zero
 * immediately after a request means we just woke up from cold.
 *
 * startedAt lazy-init: workerd returns 0 for `Date.now()` at
 * module-evaluation time because IO is gated until the first request.
 * Initialize lazily on the first hit/miss/snapshot so the timestamp
 * reflects actual module-first-touched-by-request time, not the
 * sentinel 0 value.
 */
const _grid = makeEmptyGrid();
let _startedAt = 0;
let _lastResetAt = 0;
function _ensureStartedAt() {
    if (_startedAt === 0) {
        const now = Date.now();
        _startedAt = now;
        _lastResetAt = now;
    }
}
/**
 * Record a cache HIT at the given tier for the given kind.
 *
 * `bytes` is the size of the payload returned by the hit, in bytes.
 * For packuments this is the JSON text length; for tarballs it's the
 * gzipped tar byte length; for assets it's the asset bytes. The caller
 * already has the size (post-fetch); passing it here is cheap.
 *
 * Pass 0 if the hit returned an empty payload (shouldn't happen in
 * practice but the API tolerates it).
 */
export function recordHit(tier, kind, bytes) {
    _ensureStartedAt();
    const cell = _grid[tier][kind];
    cell.hits++;
    // Negative bytes is meaningless; coerce to 0. We trust the caller for
    // accuracy but defend against accidental -1 sentinels.
    cell.bytes += bytes > 0 ? bytes : 0;
}
/**
 * Record a cache MISS at the given tier for the given kind.
 *
 * Misses don't carry payload bytes. A miss at tier N typically means
 * the caller will fall through to tier N+1; that downstream call will
 * record its OWN hit or miss. So a single fetch flow naturally records
 * a chain of misses ending in one hit at the tier that served the data.
 *
 * Example: cold fetch of `react@18.3.1` tarball records:
 *
 *   recordMiss('L1', 'tarball');
 *   recordMiss('L2', 'tarball');
 *   recordMiss('L3', 'tarball');
 *   recordHit('L4', 'tarball', 12345);  // bytes from registry response
 *
 * After the writeback path runs, the same key from a subsequent fetch
 * would record:
 *
 *   recordMiss('L1', 'tarball');
 *   recordHit('L2', 'tarball', 12345);
 */
export function recordMiss(tier, kind) {
    _ensureStartedAt();
    _grid[tier][kind].misses++;
}
/**
 * Return a snapshot of current counters + derived hit-rates.
 *
 * The returned object is a fresh copy — caller-side mutations don't
 * affect the singleton. Mirrors readDiagCounters() in diag-counters.ts.
 */
export function snapshot() {
    _ensureStartedAt();
    // Deep copy so caller mutations don't leak back into the singleton.
    const byTier = {};
    const hitRate = {};
    for (const tier of TIERS) {
        byTier[tier] = {};
        hitRate[tier] = {};
        for (const kind of KINDS) {
            const c = _grid[tier][kind];
            byTier[tier][kind] = { hits: c.hits, misses: c.misses, bytes: c.bytes };
            const lookups = c.hits + c.misses;
            hitRate[tier][kind] = lookups === 0 ? 0 : c.hits / lookups;
        }
    }
    return {
        byTier,
        startedAt: _startedAt,
        lastResetAt: _lastResetAt,
        hitRate,
    };
}
/**
 * Zero all counters. Sets lastResetAt to now. Used by the
 * `/api/_diag/cache/reset` endpoint to start a fresh measurement window.
 *
 * Does NOT clear startedAt — that remains the original module-load time
 * so operators can tell "this isolate has been up for X but counters
 * were reset at Y" (the gap is intentional vs an isolate reboot).
 */
export function reset() {
    for (const tier of TIERS) {
        for (const kind of KINDS) {
            _grid[tier][kind].hits = 0;
            _grid[tier][kind].misses = 0;
            _grid[tier][kind].bytes = 0;
        }
    }
    _lastResetAt = Date.now();
}
export function recordCacheStatEvents(events) {
    if (!events || events.length === 0)
        return;
    for (const e of events) {
        if (e.kind === 'hit') {
            recordHit(e.tier, e.cacheKind, e.bytes);
        }
        else {
            recordMiss(e.tier, e.cacheKind);
        }
    }
}
