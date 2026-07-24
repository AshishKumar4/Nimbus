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
 *   tarball:    `${R2_CACHE_PREFIX}/t/<sri-algo>/<sri-digest-hex>.tgz`
 *   packument:  `${R2_CACHE_PREFIX}/pc/<name>.json  (corgi/abbreviated format)`
 *
 * Why two buckets:
 *   Tarballs are content-addressed and never expire. Packuments must
 *   expire (TTL). Different eviction policies → different buckets, so
 *   storage / quota / monitoring stay clean.
 *
 * Why tarballs are keyed by digest, not by `name@version`:
 *   The bucket is shared by every tenant, so a tenant that can choose a
 *   key can choose whose install it poisons. `name@version` is NOT a
 *   safe key: npm alias syntax (`npm i react@npm:evil@1.0.0`) lets the
 *   install name be picked independently of the registry package, so
 *   evil's bytes would land on react's key and pass evil's own integrity
 *   check. Keyed by the resolved integrity digest instead, a writer can
 *   only ever address its own bytes, and every read re-hashes what the
 *   store returned before handing it back. The store's contract is
 *   therefore absolute: an object at key K hashes to K, or it is not
 *   served. Shared storage is treated as untrusted.
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
 *  poisoned a class of keys).
 *
 *  v1 → v2: tarball keys moved from `name@version` to the content
 *  address. Every `v1/` object is abandoned — the old keyspace was
 *  tenant-writable under an attacker-chosen name and may contain
 *  planted bytes. `v1/` objects are orphaned and safe to delete
 *  out-of-band. */
export declare const R2_CACHE_PREFIX = "v2";
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
 * L2 cache-key URL for a packument name. The L2 and L3 keyspaces are
 * derived from the same string so a schema bump moves both at once.
 * encodeURIComponent on the name so '@scope/pkg' becomes a single path
 * segment (R2 keys allow any UTF-8, but URL paths need encoding).
 */
export declare function packumentL2Url(name: string): string;
/** L2 cache-key URL for a tarball content address. Hex + the SRI algo
 *  name are already URL-safe, so the R2 key doubles as the URL path. */
export declare function tarballL2Url(address: TarballAddress): string;
/**
 * A tarball's content address: the resolved integrity digest, parsed.
 * Holding the parsed form (rather than the raw SRI string) is what makes
 * it impossible to build a cache key out of something unverifiable —
 * the only way to get one is through `parseTarballAddress`.
 */
export interface TarballAddress {
    /** SRI algorithm prefix, lowercase (e.g. 'sha512'). */
    algo: string;
    /** Web-Crypto digest identifier (e.g. 'SHA-512'). */
    digestAlgo: string;
    /** Lowercase hex digest. */
    hex: string;
}
/**
 * Parse an npm subresource-integrity string ("sha512-<base64>") into a
 * content address.
 *
 * Returns null for anything we cannot verify: an empty string, a bare
 * legacy `dist.shasum` (hex, no algorithm prefix), a multi-entry SRI, an
 * unknown algorithm, or malformed base64. A null address means the
 * tarball does not participate in the shared cache at all — we neither
 * read nor write it. Refusing to cache what we cannot verify is the
 * whole point; there is no "trust the name instead" fallback.
 */
export declare function parseTarballAddress(integrity: string): TarballAddress | null;
/**
 * Compose the R2 object key for a tarball from its content address.
 *
 *   sha512-A9c/... → `v2/t/sha512/6b86b273ff34fce1…9d9d.tgz`
 *
 * The key IS the digest, so a writer can only ever address its own
 * bytes. Package name and version appear nowhere in the keyspace.
 */
export declare function tarballKey(address: TarballAddress): string;
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
     * Get the tarball stored at `integrity`'s content address, or null if
     * absent / unverifiable / oversize-bypassed.
     *
     * The returned bytes are ALWAYS re-hashed against the address first.
     * The bucket is shared by every tenant, so it is treated as untrusted
     * storage: whatever it hands back is only served on if it hashes to
     * the key it was asked for. A caller can therefore consume the bytes
     * directly — no second verification anywhere downstream.
     *
     * L2 (`caches.default`) fronts the R2 read with an eternal-immutable
     * TTL, which a content-addressed keyspace makes trivially correct.
     * An L2 entry that fails verification is ignored and the read falls
     * through to L3.
     */
    getTarball(integrity: string): Promise<Uint8Array | null>;
    /**
     * Store a tarball at `integrity`'s content address. Bytes are stored
     * as-is (gzipped tar). No-op if the bucket binding is missing, if the
     * integrity string is not a verifiable SRI, or if the bytes do not
     * hash to the address — a caller cannot place bytes under someone
     * else's key, which keeps the store's contract absolute.
     *
     * Returns true on success, false otherwise (the cache is best-effort;
     * failure must not break the install).
     */
    putTarball(integrity: string, bytes: Uint8Array | ArrayBuffer): Promise<boolean>;
    /** Delete a single tarball cache entry. Idempotent. */
    deleteTarball(integrity: string): Promise<boolean>;
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