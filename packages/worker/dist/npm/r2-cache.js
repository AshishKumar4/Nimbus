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
 *   3. Out-of-band delete (wrangler / the R2 dashboard). Nothing inside
 *      the worker deletes cache entries: a delete reachable from a
 *      session would be a cross-tenant eviction primitive, and content
 *      addressing means a poisoned key cannot exist to need purging.
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
 *  poisoned a class of keys).
 *
 *  v1 → v2: tarball keys moved from `name@version` to the content
 *  address. Every `v1/` object is abandoned — the old keyspace was
 *  tenant-writable under an attacker-chosen name and may contain
 *  planted bytes. `v1/` objects are orphaned and safe to delete
 *  out-of-band. */
export const R2_CACHE_PREFIX = 'v2';
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
/** npm registry origin. The only host the packument cache is filled from. */
const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
/** Jittered backoff between packument fetch attempts. */
const PACKUMENT_BACKOFF_MS = [500, 1500, 4500];
/** The registry URL a packument is read from — also what `npm http` lines report. */
export function packumentUrl(name) {
    const safeName = name.startsWith('@')
        ? '@' + encodeURIComponent(name.slice(1))
        : encodeURIComponent(name);
    return `${NPM_REGISTRY_ORIGIN}/${safeName}`;
}
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
/** Synthetic L2 cache-key host. RFC-6761 reserved TLD. */
const L2_KEY_HOST = 'https://nimbus-cache.invalid';
/**
 * L2 cache-key URL for a packument name. The L2 and L3 keyspaces are
 * derived from the same string so a schema bump moves both at once.
 * encodeURIComponent on the name so '@scope/pkg' becomes a single path
 * segment (R2 keys allow any UTF-8, but URL paths need encoding).
 */
export function packumentL2Url(name) {
    return `${L2_KEY_HOST}/${R2_CACHE_PREFIX}/pc/${encodeURIComponent(name)}.json`;
}
/** L2 cache-key URL for a tarball content address. Hex + the SRI algo
 *  name are already URL-safe, so the R2 key doubles as the URL path. */
export function tarballL2Url(address) {
    return `${L2_KEY_HOST}/${tarballKey(address)}`;
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
// ── Content addressing ──────────────────────────────────────────────────
/** Web-Crypto digest name per npm subresource-integrity algorithm. */
const SRI_DIGEST_ALGOS = {
    sha512: 'SHA-512',
    sha384: 'SHA-384',
    sha256: 'SHA-256',
    sha1: 'SHA-1',
};
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
export function parseTarballAddress(integrity) {
    if (typeof integrity !== 'string')
        return null;
    const dash = integrity.indexOf('-');
    if (dash <= 0)
        return null;
    const algo = integrity.slice(0, dash).toLowerCase();
    const digestAlgo = SRI_DIGEST_ALGOS[algo];
    if (!digestAlgo)
        return null;
    const b64 = integrity.slice(dash + 1);
    // A single SRI entry only. Whitespace means a multi-hash string, which
    // the install facet's verifier does not understand either.
    if (!b64 || /\s/.test(b64))
        return null;
    let raw;
    try {
        raw = atob(b64);
    }
    catch {
        return null;
    }
    let hex = '';
    for (let i = 0; i < raw.length; i++) {
        hex += raw.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return { algo, digestAlgo, hex };
}
/** Whether `bytes` hash to `address` under its own algorithm. */
async function bytesMatchAddress(bytes, address) {
    const digest = new Uint8Array(await crypto.subtle.digest(address.digestAlgo, bytes));
    let hex = '';
    for (let i = 0; i < digest.length; i++)
        hex += digest[i].toString(16).padStart(2, '0');
    return hex === address.hex;
}
// ── Key helpers ─────────────────────────────────────────────────────────
/**
 * Compose the R2 object key for a tarball from its content address.
 *
 *   sha512-A9c/... → `v2/t/sha512/6b86b273ff34fce1…9d9d.tgz`
 *
 * The key IS the digest, so a writer can only ever address its own
 * bytes. Package name and version appear nowhere in the keyspace.
 */
export function tarballKey(address) {
    return `${R2_CACHE_PREFIX}/t/${address.algo}/${address.hex}.tgz`;
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
    async getTarball(integrity) {
        const address = parseTarballAddress(integrity);
        if (!address) {
            // Nothing verifiable to look up. Report the same miss pair as an
            // unconfigured binding: the caller goes to L4 either way.
            this._recordMiss('L2', 'tarball');
            this._recordMiss('L3', 'tarball');
            return null;
        }
        // ── L2 fast path (per-colo) ───────────────────────────────────
        const l2Key = new Request(tarballL2Url(address));
        const l2Hit = await l2Get(l2Key);
        if (l2Hit) {
            this._l2HitsTarball++;
            const ab = await l2Hit.arrayBuffer();
            // Oversize entries would blow the structured-clone cap on the way
            // back to the facet; from the consumer's POV "L2 gave me no usable
            // bytes" → miss, and they go to L4.
            if (ab.byteLength <= MAX_R2_TARBALL_BYTES) {
                const bytes = new Uint8Array(ab);
                if (await bytesMatchAddress(bytes, address)) {
                    this._recordHit('L2', 'tarball', ab.byteLength);
                    return bytes;
                }
            }
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
        const obj = await this.tarballBucket.get(tarballKey(address));
        if (!obj) {
            this._recordMiss('L3', 'tarball');
            return null;
        }
        const ab = await obj.arrayBuffer();
        if (ab.byteLength > MAX_R2_TARBALL_BYTES) {
            this._recordMiss('L3', 'tarball');
            return null;
        }
        // Pass a fresh Uint8Array to Response so the underlying buffer
        // is not detached when the original ArrayBuffer is consumed by
        // the caller. The caller receives `wb` (the same view), and the
        // cache writes a copy — workerd serializes through structured
        // clone for `caches.default.put`.
        const wb = new Uint8Array(ab);
        if (!await bytesMatchAddress(wb, address)) {
            this._recordMiss('L3', 'tarball');
            return null;
        }
        this._recordHit('L3', 'tarball', ab.byteLength);
        // Write through to L2. Best-effort: failure is silent.
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
     * Store a tarball at `integrity`'s content address. Bytes are stored
     * as-is (gzipped tar). No-op if the bucket binding is missing, if the
     * integrity string is not a verifiable SRI, or if the bytes do not
     * hash to the address — a caller cannot place bytes under someone
     * else's key, which keeps the store's contract absolute.
     *
     * Returns true on success, false otherwise (the cache is best-effort;
     * failure must not break the install).
     */
    async putTarball(integrity, bytes) {
        if (!this.tarballBucket)
            return false;
        const address = parseTarballAddress(integrity);
        if (!address)
            return false;
        const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
        if (view.length > MAX_R2_TARBALL_BYTES)
            return false;
        if (!await bytesMatchAddress(view, address))
            return false;
        try {
            await this.tarballBucket.put(tarballKey(address), view, {
                httpMetadata: { contentType: 'application/gzip' },
            });
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
        const l2Key = new Request(packumentL2Url(name));
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
     * Resolve a packument through the whole stack: cache read, and on a
     * miss (or an expired entry) the registry fetch plus the cache fill.
     *
     * This is the ONLY thing that fills the cross-tenant packument cache,
     * and that is a security property, not a layering preference. A
     * packument dictates the tarball URL and integrity digest for every
     * tenant that later reads it, so accepting caller-supplied bytes would
     * hand anyone who can reach this client the ability to redirect other
     * tenants' installs at an arbitrary URL with a matching digest — the
     * content-addressed tarball store cannot catch that, because the
     * attacker would be choosing the address too. Here, the only bytes
     * that reach `pc/<name>.json` are the ones registry.npmjs.org served
     * for that exact name, one line below the fetch that produced them.
     *
     * `status` is set when the registry answered 4xx (no such package);
     * `failure` when every attempt failed. Both leave `json` null.
     */
    async readThroughPackument(name, options) {
        const cached = await this.getPackument(name);
        if (cached && !cached.expired && cached.json) {
            return { json: cached.json, source: 'r2-cache' };
        }
        const url = packumentUrl(name);
        const retries = Math.max(0, options?.retries ?? 3);
        const timeoutMs = options?.timeoutMs ?? 15_000;
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const ctl = new AbortController();
                const timer = setTimeout(() => ctl.abort(), timeoutMs);
                let resp;
                try {
                    // Corgi (abbreviated) packument — up to ~17x smaller than the
                    // full doc (vite: 38MB→2.2MB). Carries every field the resolver
                    // reads (dependencies/peer/peerMeta/optional/dist/bin/os/cpu/
                    // libc). It omits `exports`; that is read from the tarball's
                    // package.json in the VFS at require time, where the resolver's
                    // packument copy is `?? null` anyway.
                    resp = await fetch(url, {
                        headers: { Accept: 'application/vnd.npm.install-v1+json' },
                        signal: ctl.signal,
                    });
                }
                finally {
                    clearTimeout(timer);
                }
                if (resp.ok) {
                    const json = await resp.text();
                    this._recordHit('L4', 'packument', json.length);
                    // Best-effort fill, awaited so a follow-up read in the same
                    // install sees it.
                    await this.putPackument(name, json);
                    return { json, source: 'network' };
                }
                if (resp.status >= 400 && resp.status < 500) {
                    // No such package. Not retryable, and not an error.
                    return { json: null, source: 'network', status: resp.status };
                }
                try {
                    await resp.body?.cancel();
                }
                catch { /* best-effort */ }
                lastErr = new Error(`HTTP ${resp.status}`);
            }
            catch (e) {
                lastErr = e;
            }
            if (attempt < retries) {
                const base = PACKUMENT_BACKOFF_MS[Math.min(attempt, PACKUMENT_BACKOFF_MS.length - 1)];
                const jitter = Math.round(base + (Math.random() * 2 - 1) * base * 0.25);
                await new Promise((rs) => setTimeout(rs, Math.max(0, jitter)));
            }
        }
        return {
            json: null,
            source: 'network',
            failure: lastErr instanceof Error ? lastErr.message : String(lastErr),
        };
    }
    /**
     * Write a packument JSON to R2 with a TTL stamp in customMetadata.
     * No-op if the bucket binding is missing.
     *
     * Only `readThroughPackument` (and the debug bench seeder) call this:
     * it is a storage primitive, never an RPC. See readThroughPackument
     * for why that matters.
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
    /** Lightweight feature-detection for callers that want to log path. */
    hasTarballBucket() {
        return this.tarballBucket !== null;
    }
    /** Lightweight feature-detection for callers that want to log path. */
    hasPackumentBucket() {
        return this.packumentBucket !== null;
    }
}
