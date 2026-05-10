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
 * Pre-cache-observability wave: hit/miss counters lived in
 * src/observability/diag-counters.ts but only tracked the RPC-call
 * boundary (`r2.tarballHit`, `r2.packumentMiss`), not per-tier. From
 * prod we couldn't tell whether L2 hit-rate was 90% or 30%.
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

/**
 * Tier in the cache stack. Each tier is checked in order from L1 (warmest,
 * fastest) down to L4 (coldest, slowest origin). Cache writes typically
 * "fill" lower numbers from higher numbers — an L4 fetch may writeback
 * to L3 and L2, an L3 hit may writeback to L2, etc.
 */
export type CacheTier = 'L1' | 'L2' | 'L3' | 'L4';

/**
 * Kind of content cached. Each kind has its own size profile and eviction
 * policy:
 *
 *   tarball   — gzipped tar bytes, immutable forever, 30 MiB cap on L3
 *   packument — registry metadata JSON, TTL-bounded (60 min post-P6),
 *               unbounded size in practice (~10 KB - 1 MB typical)
 *   asset     — non-package binaries cached cross-tenant (esbuild.wasm,
 *               rolldown.wasm, etc.). Immutable forever, low churn.
 */
export type CacheKind = 'tarball' | 'packument' | 'asset';

/**
 * Per-(tier, kind) cell. A hit happened when we asked the tier "do you
 * have <key>?" and it said yes (and returned bytes). A miss happened when
 * we asked and it said no.
 *
 * `bytes` accumulates the size of HIT payloads only — misses have no
 * bytes by definition. This means:
 *
 *   bytes / hits = average hit payload size
 *
 * which is the metric operators care about for capacity planning.
 */
export interface CacheCell {
  hits: number;
  misses: number;
  /** Cumulative bytes returned on hits. Does NOT include miss "size" (0). */
  bytes: number;
}

export interface CacheStatsSnapshot {
  /** Tier × Kind grid. Each cell tracks hits, misses, bytes-on-hit. */
  byTier: Record<CacheTier, Record<CacheKind, CacheCell>>;
  /**
   * Wall-clock ms at module load (when this isolate first received a
   * request that imported this module). Stable across requests within
   * the same isolate; resets on DO reboot (itself a useful signal).
   */
  startedAt: number;
  /**
   * Wall-clock ms at the most recent `reset()` call. Equals startedAt
   * if reset() has never been called.
   */
  lastResetAt: number;
  /**
   * Derived hit-rate per (tier, kind), 0..1. Computed as
   * hits / (hits + misses). NaN-safe: returns 0 when (hits + misses)
   * is 0 so JSON serialisation stays clean. Mirrors the byTier shape
   * exactly so consumers can ZIP the two structures with the same key
   * paths.
   */
  hitRate: Record<CacheTier, Record<CacheKind, number>>;
}

const TIERS: CacheTier[] = ['L1', 'L2', 'L3', 'L4'];
const KINDS: CacheKind[] = ['tarball', 'packument', 'asset'];

function makeEmptyGrid(): Record<CacheTier, Record<CacheKind, CacheCell>> {
  const grid = {} as Record<CacheTier, Record<CacheKind, CacheCell>>;
  for (const tier of TIERS) {
    grid[tier] = {} as Record<CacheKind, CacheCell>;
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
function _ensureStartedAt(): void {
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
export function recordHit(tier: CacheTier, kind: CacheKind, bytes: number): void {
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
export function recordMiss(tier: CacheTier, kind: CacheKind): void {
  _ensureStartedAt();
  _grid[tier][kind].misses++;
}

/**
 * Return a snapshot of current counters + derived hit-rates.
 *
 * The returned object is a fresh copy — caller-side mutations don't
 * affect the singleton. Mirrors readDiagCounters() in diag-counters.ts.
 */
export function snapshot(): CacheStatsSnapshot {
  _ensureStartedAt();
  // Deep copy so caller mutations don't leak back into the singleton.
  const byTier = {} as Record<CacheTier, Record<CacheKind, CacheCell>>;
  const hitRate = {} as Record<CacheTier, Record<CacheKind, number>>;
  for (const tier of TIERS) {
    byTier[tier] = {} as Record<CacheKind, CacheCell>;
    hitRate[tier] = {} as Record<CacheKind, number>;
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
export function reset(): void {
  for (const tier of TIERS) {
    for (const kind of KINDS) {
      _grid[tier][kind].hits = 0;
      _grid[tier][kind].misses = 0;
      _grid[tier][kind].bytes = 0;
    }
  }
  _lastResetAt = Date.now();
}
