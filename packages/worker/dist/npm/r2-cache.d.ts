/**
 * r2-cache.ts — cross-tenant npm cache backed by R2 and caches.default.
 *
 * Purpose
 * ───────
 * The supervisor DO already maintains a per-tenant SQLite cache. This
 * module adds a cross-tenant tier in R2 so that one tenant's first install
 * of a package benefits subsequent tenants on the platform.
 *
 * Caching layers (top-down):
 *   L1 — per-DO SQLite (warmest, in-memory; ~1 ms per file)
 *   L2 — caches.default (per-colo; ~50-500 µs hit / ~5-30 ms cold)
 *   L3 — R2 (global; ~30-100 ms regional)
 *   L4 — registry.npmjs.org origin (~100-300 ms cross-region)
 *
 * Two buckets, two key shapes:
 *   tarball:    `${R2_CACHE_PREFIX}/t/<name>/<version>.tgz`
 *   packument:  `${R2_CACHE_PREFIX}/p/<name>.json`
 *
 * Why two buckets:
 *   Tarballs are immutable (npm name@version is content-fixed since 2018).
 *   Packuments must expire (5-min TTL). Different eviction policies →
 *   different buckets, so storage / quota / monitoring stay clean.
 *
 * Cache invalidation:
 *   1. Time-based, packuments only — TTL encoded in customMetadata.expiresAt
 *   2. Schema bump — bump R2_CACHE_PREFIX to invalidate everything atomically.
 *      Stale data is left in place; bucket lifecycle policy can sweep it.
 *   3. Manual delete — deleteTarball / deletePackument; useful in incident
 *      response (a poisoned cache key needs purging).
 *
 * Graceful degrade:
 *   If env.NPM_TARBALL_CACHE / NPM_PACKUMENT_CACHE bindings are missing
 *   (deploy without buckets created, or wrangler dev without remote
 *   buckets), all R2 calls return null on read and no-op on write. The
 *   installer falls through to the existing network-fetch path with
 *   identical behaviour to the uncached install path.
 *
 * Deliberately out of scope here:
 *   - Streamed R2 reads via ReadableStream<Uint8Array> RPC return type
 *     Today: bytes returned via structured-clone
 *     subject to the 32 MiB cap. Packages > 30 MiB skip the R2 path and
 *     stream directly from npm.
 *   - npm publish webhook -> cache invalidation.
 */
import type { CacheTier, CacheKind } from '../_shared/cache-stats.js';
/**
 * Per-call cache-stat event (cache metrics support). R2CacheClient
 * accumulates these in instance state so the SupervisorRPC caller can
 * drain + forward to the DO isolate (where /api/_diag/cache reads from).
 * The local-singleton-write approach would be invisible to the DO's
 * diag endpoint because WorkerEntrypoint instances live in a separate
 * isolate. See src/session/supervisor-rpc.ts for the flush.
 */
export type R2CacheStatEvent = {
    kind: 'hit';
    tier: CacheTier;
    cacheKind: CacheKind;
    bytes: number;
} | {
    kind: 'miss';
    tier: CacheTier;
    cacheKind: CacheKind;
};
/** Schema version baked into every cache key. Bump to invalidate
 *  everything atomically (e.g. if the storage shape changes or a bug
 *  poisoned a class of keys). */
export declare const R2_CACHE_PREFIX = "v1";
/** Packument TTL — 60 min (cache metrics support; was 5 min pre-wave).
 *
 *  Rationale for the bump (~12× longer than pre-wave):
 *
 *  - npm registry packuments change ONLY when a new version of the
 *    package is published. For >99% of packages this is sub-weekly.
 *  - The 5-min TTL fired roughly once per minute on a long install
 *    session (resolver re-fetches as dep BFS re-encounters cached
 *    names with new range constraints). 12× fewer re-fetches at
 *    60 min TTL means ~12× lower registry roundtrip count for an
 *    equivalent workload.
 *  - npm registry origin is shared across all Nimbus users; lower
 *    aggregate load is good citizenship and lowers our risk of being
 *    rate-limited at the L4 boundary.
 *
 *  Trade-off (the cost of the bump):
 *
 *  - A package version published less than 60 min ago may not be
 *    resolvable from a Nimbus session whose colo's L2 cache has a
 *    pre-publish entry. Worst case: a user `npm i my-fresh@1.0.1`
 *    seconds after publishing my-fresh@1.0.1 sees the cached 1.0.0
 *    entry for up to 60 min.
 *  - Workaround for users hitting freshness issues: open a new
 *    session in a different colo (cold L2), OR wait for the TTL,
 *    OR (future) add `NIMBUS_CACHE_TTL_MS` env override.
 *
 *  Reversibility: redeploy with this constant restored to 5*60_000
 *  reverts the behavior instantly (next request reads the new TTL).
 *  No data migration; existing R2 packument entries' customMetadata
 *  .expiresAt stamps remain valid against either TTL. */
export declare const PACKUMENT_TTL_MS: number;
/** Cap on tarball bytes returned via this RPC. Workerd structured-clone
 *  cap is 32 MiB; we keep a comfortable margin to leave room for RPC
 *  framing + the call's own arg bytes. Tarballs above this size skip
 *  the R2 path and go straight to the network — they're the long tail
 *  for which W7 (streams over RPC) will close the gap. */
export declare const MAX_R2_TARBALL_BYTES: number;
export interface CachedPackument {
    /** Raw packument JSON text. JSON.parse at call-site (caller already
     *  pays the parse cost on the network path; mirroring keeps the
     *  call-site interchangeable). */
    json: string;
    /** Approximate age in ms based on R2's `uploaded` timestamp. May be
     *  slightly skewed if customMetadata.expiresAt is set. */
    ageMs: number;
    /** Whether this entry has passed its TTL. Caller MUST honour this:
     *  expired entries are returned only as a stale-while-error fallback,
     *  never as a hot-path hit. */
    expired: boolean;
}
/** Optional R2 binding shape (we treat null as "not provisioned"). */
type R2BucketLike = {
    get(key: string): Promise<{
        arrayBuffer(): Promise<ArrayBuffer>;
        text(): Promise<string>;
        uploaded?: Date;
        customMetadata?: Record<string, string>;
    } | null>;
    put(key: string, body: Uint8Array | ArrayBuffer | string, opts?: {
        httpMetadata?: {
            contentType?: string;
        };
        customMetadata?: Record<string, string>;
    }): Promise<unknown>;
    delete(key: string): Promise<unknown>;
} | null;
/**
 * Synthetic L2 cache-key host. RFC-6761 reserved TLD.
 *
 * CLN-1 (2026-05-11): exported so `session/routes.ts` cache-purge helpers
 * can use the same constant instead of hardcoding the literal. Bumping
 * the schema (e.g. `nimbus-cache-v2.invalid`) now only requires editing
 * one line.
 */
export declare const L2_KEY_HOST = "https://nimbus-cache.invalid";
/**
 * Compose the R2 object key for a tarball.
 *
 * Tarball keys use `t/<name>/<version>.tgz`. Scope-prefixed
 * names (`@scope/pkg`) keep their `@` and `/` because R2 keys allow any
 * UTF-8; we don't URL-encode them. Examples:
 *
 *   react@19.0.0                  → `v1/t/react/19.0.0.tgz`
 *   @vitejs/plugin-react@4.3.4    → `v1/t/@vitejs/plugin-react/4.3.4.tgz`
 *
 * The integrity digest is not in the key; reads validate integrity
 * post-fetch. This shape enables pipelining: as soon as the resolver yields
 * {name, version}, the install facet can speculatively kick off getTarball()
 * in parallel with the network fetch.
 */
export declare function tarballKey(name: string, version: string): string;
/** Compose the R2 object key for a packument. */
export declare function packumentKey(name: string): string;
/**
 * Per-instance counters surfaced for tests / probes. Read via
 * `R2CacheClient.stats()`. Track at the FUNCTION boundary level so a
 * call that hits L2 bumps `l2HitsPackument` but NOT `l3GetsPackument`,
 * "after the first call, no more l3GetsPackument" — structurally
 * proving the L2 layer is functional even when local-dev wall-clock
 * latency is too noisy to demonstrate 5×.
 *
 * Diag counters (src/observability/diag-counters.ts) bump for the
 * SupervisorRPC layer (RPC-perspective hit/miss). These per-instance
 * counters bump for the R2CacheClient call surface itself (L2 vs L3
 * vs miss), independent of who's calling.
 */
export interface R2CacheClientStats {
    l2HitsPackument: number;
    l3GetsPackument: number;
    l2HitsTarball: number;
    l3GetsTarball: number;
}
/**
 * R2-backed npm cache client. Wraps two R2 bindings (tarballs + packuments)
 * with the get/put/delete shape the SupervisorRPC methods need, fronted
 * by an L2 colo cache via `caches.default`.
 *
 * Constructed once per request-scope (typically inside SupervisorRPC
 * methods). Cheap to instantiate — no async init.
 *
 * ALL methods are null-bucket safe: pass `null` for either binding and
 * the corresponding read returns null / write is a no-op. The L2 layer
 * is also null-safe: missing `caches.default` falls through to the
 * graceful-degrade path that mirrors today's behaviour.
 */
export declare class R2CacheClient {
    private readonly tarballBucket;
    private readonly packumentBucket;
    private _l2HitsPackument;
    private _l3GetsPackument;
    private _l2HitsTarball;
    private _l3GetsTarball;
    /**
     * Cache-observability wave: per-call events accumulated for the
     * caller (SupervisorRPC) to forward to the DO isolate's cache-stats
     * singleton. Read via _cacheEvents and replaced with a fresh [] on
     * drain. Public field so the caller in supervisor-rpc.ts can drain
     * without an explicit method call (saves an indirection).
     */
    _cacheEvents: R2CacheStatEvent[];
    constructor(tarballBucket: R2BucketLike, packumentBucket: R2BucketLike);
    private _recordHit;
    private _recordMiss;
    /** Per-instance counter snapshot. Used by the L2 cache probes. */
    stats(): R2CacheClientStats;
    /**
     * Get a cached tarball, or null if absent / oversize-bypassed.
     *
     * Returns the gzipped tar bytes as Uint8Array. Caller is responsible
     * for integrity verification before consuming — we do NOT verify here
     * because the caller (batch-facet) has the integrity hash from the
     * resolver's packument.
     *
     * L2 (cache-and-scrub W-B): we wrap the R2 read in `caches.default`
     * with `Cache-Control: public, max-age=31536000, immutable` because
     * `name@version` is content-addressed (immutable npm contract since
     * 2018). On miss, fall through to R2 and write through to L2.
     */
    getTarball(name: string, version: string): Promise<Uint8Array | null>;
    /**
     * Write a tarball to R2. Bytes are stored as-is (gzipped tar). No-op
     * if the bucket binding is missing.
     *
     * Caller must ensure bytes have already passed integrity verification.
     * We accept ArrayBuffer or Uint8Array. Returns true on success, false
     * on failure (the cache is best-effort; failure must not break the
     * install).
     */
    putTarball(name: string, version: string, bytes: Uint8Array | ArrayBuffer): Promise<boolean>;
    /** Delete a single tarball cache entry. Idempotent. */
    deleteTarball(name: string, version: string): Promise<boolean>;
    /**
     * Get a cached packument with its TTL state.
     *
     * Returns CachedPackument with `expired` set true when the entry's
     * customMetadata.expiresAt is in the past. Callers MUST honour
     * `expired` — only treat as a hot hit when false. Stale-while-error
     * is the only valid use of expired data.
     *
     * L2 (cache-and-scrub W-A): we wrap the R2 read in `caches.default`.
     * On hit, we read both the packument JSON and the absolute
     * `expiresAt` timestamp from the L2 entry's headers — the absolute
     * timestamp matters because L2 may serve a cached response near
     * the end of its 5-min TTL, and the caller's `expired` check still
     * needs to fire correctly. On miss, we fall through to R2 and
     * write back to L2 with a 5-min `Cache-Control: max-age=300`
     * (matching the existing R2 customMetadata.expiresAt semantic).
     */
    getPackument(name: string): Promise<CachedPackument | null>;
    /**
     * Write a packument JSON to R2 with a TTL stamp in customMetadata.
     * No-op if the bucket binding is missing.
     *
     * Returns true on success, false on failure (same best-effort posture
     * as putTarball).
     */
    putPackument(name: string, json: string): Promise<boolean>;
    /** Delete a single packument cache entry. Idempotent. */
    deletePackument(name: string): Promise<boolean>;
    /** Lightweight feature-detection for callers that want to log path. */
    hasTarballBucket(): boolean;
    /** Lightweight feature-detection for callers that want to log path. */
    hasPackumentBucket(): boolean;
}
export {};
//# sourceMappingURL=r2-cache.d.ts.map