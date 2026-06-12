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
 *   packument:  `${R2_CACHE_PREFIX}/pc/<name>.json  (corgi/abbreviated format)`
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
/** Schema version baked into every cache key. Bump to invalidate
 *  everything atomically (e.g. if the storage shape changes or a bug
 *  poisoned a class of keys). */
export const R2_CACHE_PREFIX = 'v1';
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
export const PACKUMENT_TTL_MS = 60 * 60_000;
/** Cap on tarball bytes returned via this RPC. Workerd structured-clone
 *  cap is 32 MiB; we keep a comfortable margin to leave room for RPC
 *  framing + the call's own arg bytes. Tarballs above this size skip
 *  the R2 path and go straight to the network — they're the long tail
 *  for which W7 (streams over RPC) will close the gap. */
export const MAX_R2_TARBALL_BYTES = 30 * 1024 * 1024;
// ── L2 (caches.default) helpers ─────────────────────────────────────────
//
// The Workers Cache API requires `Request` instances as keys. We
// synthesize stable URLs in a reserved-invalid namespace so they
// can't collide with any user-visible request. The TTL is encoded
// in the wrapped Response's `Cache-Control` header — the cache layer
// honours it on its own (no manual expiration check needed inside
// `cacheGetBytes`).
//
// Why a dedicated invalid host:
//   - Prevents accidental collisions with same-origin user requests.
//   - `nimbus-cache.invalid.` is reserved per RFC 6761 (`.invalid.`
//     TLD) so it can never resolve and never escapes the worker.
/**
 * Synthetic L2 cache-key host. RFC-6761 reserved TLD.
 *
 * CLN-1 (2026-05-11): exported so `session/routes.ts` cache-purge helpers
 * can use the same constant instead of hardcoding the literal. Bumping
 * the schema (e.g. `nimbus-cache-v2.invalid`) now only requires editing
 * one line.
 */
export const L2_KEY_HOST = 'https://nimbus-cache.invalid';
/** Build the L2 cache-key Request for a packument name. */
function packumentL2Key(name) {
    // encodeURIComponent on the name so '@scope/pkg' becomes a single
    // path segment — matches our R2 key shape's `${name}.json` (R2 keys
    // allow any UTF-8, but URL paths need encoding).
    return new Request(`${L2_KEY_HOST}/${R2_CACHE_PREFIX}/pc/${encodeURIComponent(name)}.json`);
}
/** Build the L2 cache-key Request for a tarball name+version. */
function tarballL2Key(name, version) {
    return new Request(`${L2_KEY_HOST}/${R2_CACHE_PREFIX}/t/${encodeURIComponent(name)}/${encodeURIComponent(version)}.tgz`);
}
/** Build the L2 cache-key Request for an asset (e.g. esbuild-wasm). */
function assetL2Key(assetPath) {
    // Caller passes an already-encoded path (e.g. "esbuild-0.24.2.wasm").
    // Sanitize defensively in case a future caller passes a raw path
    // with leading slashes or query strings.
    const clean = assetPath.replace(/^\/+/, '').split('?')[0];
    return new Request(`${L2_KEY_HOST}/${R2_CACHE_PREFIX}/a/${clean}`);
}
/**
 * Best-effort `caches.default` lookup. Returns null on miss / when the
 * Cache API is not exposed (some test harnesses) / on any thrown error.
 *
 * The Cache API is bound to `caches.default` in workerd; we tolerate it
 * being absent (e.g. a test harness with a stripped global) so the
 * graceful-degrade contract from the original L3 layer extends to L2.
 */
async function l2Get(key) {
    try {
        const c = globalThis.caches;
        if (!c?.default)
            return null;
        const r = await c.default.match(key);
        return r ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Best-effort `caches.default` write. The body Response must have a
 * `Cache-Control` header with `max-age` for the cache layer to honour
 * a TTL — without it, the cache MAY refuse to store. We always set it
 * at call sites (eternal for tarball/asset; 5 min for packument).
 *
 * Returns true on success, false on any thrown error. Failure here
 * MUST NOT block the L3 hit — the wrap is a perf optimisation only.
 */
async function l2Put(key, body) {
    try {
        const c = globalThis.caches;
        if (!c?.default)
            return false;
        await c.default.put(key, body);
        return true;
    }
    catch {
        return false;
    }
}
// ── Key helpers ─────────────────────────────────────────────────────────
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
export function tarballKey(name, version) {
    return `${R2_CACHE_PREFIX}/t/${name}/${version}.tgz`;
}
/** Compose the R2 object key for a packument. */
export function packumentKey(name) {
    return `${R2_CACHE_PREFIX}/pc/${name}.json`;
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
export class R2CacheClient {
    tarballBucket;
    packumentBucket;
    _l2HitsPackument = 0;
    _l3GetsPackument = 0;
    _l2HitsTarball = 0;
    _l3GetsTarball = 0;
    /**
     * Cache-observability wave: per-call events accumulated for the
     * caller (SupervisorRPC) to forward to the DO isolate's cache-stats
     * singleton. Read via _cacheEvents and replaced with a fresh [] on
     * drain. Public field so the caller in supervisor-rpc.ts can drain
     * without an explicit method call (saves an indirection).
     */
    _cacheEvents = [];
    constructor(tarballBucket, packumentBucket) {
        this.tarballBucket = tarballBucket;
        this.packumentBucket = packumentBucket;
    }
    _recordHit(tier, cacheKind, bytes) {
        this._cacheEvents.push({ kind: 'hit', tier, cacheKind, bytes });
    }
    _recordMiss(tier, cacheKind) {
        this._cacheEvents.push({ kind: 'miss', tier, cacheKind });
    }
    /** Per-instance counter snapshot. Used by the L2 cache probes. */
    stats() {
        return {
            l2HitsPackument: this._l2HitsPackument,
            l3GetsPackument: this._l3GetsPackument,
            l2HitsTarball: this._l2HitsTarball,
            l3GetsTarball: this._l3GetsTarball,
        };
    }
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
    async getTarball(name, version) {
        // ── L2 fast path (per-colo) ───────────────────────────────────
        const l2Key = tarballL2Key(name, version);
        const l2Hit = await l2Get(l2Key);
        if (l2Hit) {
            this._l2HitsTarball++;
            const ab = await l2Hit.arrayBuffer();
            if (ab.byteLength > MAX_R2_TARBALL_BYTES) {
                // Defensive bypass — record as miss (callable returns null,
                // caller MUST fall through to L4). The L2 entry technically
                // existed but is unusable; the consumer's POV is "L2 didn't
                // give me usable bytes" → miss.
                this._recordMiss('L2', 'tarball');
                return null;
            }
            this._recordHit('L2', 'tarball', ab.byteLength);
            return new Uint8Array(ab);
        }
        this._recordMiss('L2', 'tarball');
        // ── L3 path (cross-tenant) ────────────────────────────────────
        if (!this.tarballBucket) {
            // No L3 binding configured — treat as miss so downstream can
            // fall through to L4. Distinguishes "binding absent" from
            // "binding present and empty" in the byte-counter (a miss
            // here means caller will fetch from L4).
            this._recordMiss('L3', 'tarball');
            return null;
        }
        this._l3GetsTarball++;
        const key = tarballKey(name, version);
        const obj = await this.tarballBucket.get(key);
        if (!obj) {
            this._recordMiss('L3', 'tarball');
            return null;
        }
        const ab = await obj.arrayBuffer();
        if (ab.byteLength > MAX_R2_TARBALL_BYTES) {
            // Defense-in-depth: a bug or admin-uploaded oversized tarball
            // shouldn't blow the structured-clone cap on the way back to
            // the facet. Treat as miss; original install path will handle it.
            // (Counter perspective: tier-3 said "yes, I have it" but the
            // payload is unusable here, so from the caller's POV it's a miss
            // — they go to L4.)
            this._recordMiss('L3', 'tarball');
            return null;
        }
        this._recordHit('L3', 'tarball', ab.byteLength);
        // Write through to L2. Eternal TTL is correct: the npm registry
        // enforces immutability — `name@version` is content-fixed since
        // 2018 (the unpublish window only allows hard-delete, never
        // overwrite). Same posture R2 uses (no TTL on the bucket). Best-
        // effort write: failure is silent.
        const wb = new Uint8Array(ab);
        // Pass a fresh Uint8Array to Response so the underlying buffer
        // is not detached when the original ArrayBuffer is consumed by
        // the caller. The caller receives `wb` (the same view), and the
        // cache writes a copy — workerd serializes through structured
        // clone for `caches.default.put`.
        const writeBack = new Response(wb, {
            headers: {
                'Content-Type': 'application/gzip',
                'Cache-Control': 'public, max-age=31536000, immutable',
            },
        });
        // Await the put so subsequent reads of the same key strictly
        // hit L2 (no double-fetch race during fill). See the matching
        // note in getPackument above.
        await l2Put(l2Key, writeBack);
        return wb;
    }
    /**
     * Write a tarball to R2. Bytes are stored as-is (gzipped tar). No-op
     * if the bucket binding is missing.
     *
     * Caller must ensure bytes have already passed integrity verification.
     * We accept ArrayBuffer or Uint8Array. Returns true on success, false
     * on failure (the cache is best-effort; failure must not break the
     * install).
     */
    async putTarball(name, version, bytes) {
        if (!this.tarballBucket)
            return false;
        const size = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.length;
        if (size > MAX_R2_TARBALL_BYTES)
            return false;
        try {
            await this.tarballBucket.put(tarballKey(name, version), bytes, {
                httpMetadata: { contentType: 'application/gzip' },
            });
            return true;
        }
        catch {
            return false;
        }
    }
    /** Delete a single tarball cache entry. Idempotent. */
    async deleteTarball(name, version) {
        if (!this.tarballBucket)
            return false;
        try {
            await this.tarballBucket.delete(tarballKey(name, version));
            return true;
        }
        catch {
            return false;
        }
    }
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
    async getPackument(name) {
        // ── L2 fast path (per-colo) ───────────────────────────────────
        const l2Key = packumentL2Key(name);
        const l2Hit = await l2Get(l2Key);
        if (l2Hit) {
            this._l2HitsPackument++;
            const json = await l2Hit.text();
            // Record L2 hit by JSON text length. Note this happens BEFORE
            // we check expired — an expired L2 entry is still served (caller
            // honours expired flag); the hit-rate counts the cache lookup
            // success, the staleness is a separate axis.
            this._recordHit('L2', 'packument', json.length);
            const now = Date.now();
            // Reconstruct ageMs from the L2 response's `Date` header (set
            // implicitly by the cache layer at put time). Cache API
            // reflects it back as `Date` on hits; if absent, default to
            // "fresh enough" (ageMs=0).
            const dateHdr = l2Hit.headers.get('date');
            const uploaded = dateHdr ? new Date(dateHdr).getTime() : now;
            const ageMs = Math.max(0, now - (Number.isFinite(uploaded) ? uploaded : now));
            // expiresAt is encoded into a custom header (`X-Nimbus-ExpiresAt`)
            // because Cache-Control's relative max-age is honoured by the
            // cache layer but doesn't survive readback as an absolute
            // timestamp. Caller still needs the absolute boundary.
            const expiresAtRaw = l2Hit.headers.get('x-nimbus-expiresat');
            const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : 0;
            const expired = expiresAt > 0
                ? now >= expiresAt
                : ageMs >= PACKUMENT_TTL_MS;
            return { json, ageMs, expired };
        }
        this._recordMiss('L2', 'packument');
        // ── L3 path (cross-tenant) ────────────────────────────────────
        if (!this.packumentBucket) {
            this._recordMiss('L3', 'packument');
            return null;
        }
        this._l3GetsPackument++;
        const obj = await this.packumentBucket.get(packumentKey(name));
        if (!obj) {
            this._recordMiss('L3', 'packument');
            return null;
        }
        const json = await obj.text();
        this._recordHit('L3', 'packument', json.length);
        const now = Date.now();
        const uploaded = obj.uploaded?.getTime() ?? now;
        const ageMs = Math.max(0, now - uploaded);
        const expiresAtRaw = obj.customMetadata?.expiresAt;
        const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : 0;
        const expired = expiresAt > 0
            ? now >= expiresAt
            : ageMs >= PACKUMENT_TTL_MS;
        // Write through to L2 — bounded by max-age=300 to match the
        // existing R2 customMetadata.expiresAt 5-min TTL. We pass the
        // absolute expiresAt as a custom header so reads can re-check
        // the boundary even if the cache layer extends our entry.
        // Best-effort: failure is silent (false return ignored).
        if (!expired) {
            const ttlSec = Math.max(1, Math.floor((expiresAt > 0 ? expiresAt - now : PACKUMENT_TTL_MS) / 1000));
            const writeBack = new Response(json, {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': `public, max-age=${ttlSec}`,
                    'X-Nimbus-ExpiresAt': String(expiresAt > 0 ? expiresAt : now + PACKUMENT_TTL_MS),
                },
            });
            // Await the L2 put so the entry is durable before we return.
            // Two callers reading the same key back-to-back during the
            // fill window would otherwise both miss L2 and double-fetch
            // L3. The cost (~1-3 ms in workerd local; sub-ms at edge) is
            // bounded by the response size and only paid on cold reads.
            // Errors are swallowed by l2Put — failure is silent.
            await l2Put(l2Key, writeBack);
        }
        return { json, ageMs, expired };
    }
    /**
     * Write a packument JSON to R2 with a TTL stamp in customMetadata.
     * No-op if the bucket binding is missing.
     *
     * Returns true on success, false on failure (same best-effort posture
     * as putTarball).
     */
    async putPackument(name, json) {
        if (!this.packumentBucket)
            return false;
        const expiresAt = Date.now() + PACKUMENT_TTL_MS;
        try {
            await this.packumentBucket.put(packumentKey(name), json, {
                httpMetadata: { contentType: 'application/json' },
                customMetadata: { expiresAt: String(expiresAt) },
            });
            return true;
        }
        catch {
            return false;
        }
    }
    /** Delete a single packument cache entry. Idempotent. */
    async deletePackument(name) {
        if (!this.packumentBucket)
            return false;
        try {
            await this.packumentBucket.delete(packumentKey(name));
            return true;
        }
        catch {
            return false;
        }
    }
    /** Lightweight feature-detection for callers that want to log path. */
    hasTarballBucket() {
        return this.tarballBucket !== null;
    }
    /** Lightweight feature-detection for callers that want to log path. */
    hasPackumentBucket() {
        return this.packumentBucket !== null;
    }
}
