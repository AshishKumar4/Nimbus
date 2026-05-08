/**
 * r2-cache.ts — L3 cross-tenant npm cache backed by R2 [W4].
 *
 * Purpose
 * ───────
 * Mirrors the Pyodide / Python Workers Package Bundling System pattern
 * (EW/SPEC at wiki.cfdata.org). The supervisor DO already maintains a
 * per-tenant SQLite cache (src/npm-cache.ts). This module adds an L3
 * cross-tenant tier in R2 so that one tenant's first-install of a package
 * benefits every subsequent tenant on the platform — the win that drops
 * Mossaic-class cold installs from ~60 s to a target ≤ 15 s.
 *
 * Caching layers (top-down):
 *   L1 — per-DO SQLite (warmest, in-memory; ~1 ms per file)
 *   L2 — Cache API (per-colo; ~5-30 ms; not yet wired — gated on D3.5)
 *   L3 — R2 (global; ~30-100 ms regional)               ← THIS MODULE
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
 *   identical behaviour to today's main.
 *
 * NOT in W4 scope (deferred):
 *   - Streamed R2 reads via ReadableStream<Uint8Array> RPC return type
 *     (W7 — Streams over RPC). Today: bytes returned via structured-clone
 *     subject to the 32 MiB cap. Packages > 30 MiB skip the R2 path and
 *     stream directly from npm.
 *   - npm publish webhook → cache invalidation (CT2 future).
 *   - L2 Cache API (D3.5) — separate work.
 *
 * References:
 *   - audit/sections/CF-INTERNAL-OPTIMIZATION-RESEARCH.md §D
 *   - audit/_drafts/D-npm-install.md (per-section provenance)
 *   - audit/sections/W4-plan.md
 */

/** Schema version baked into every cache key. Bump to invalidate
 *  everything atomically (e.g. if the storage shape changes or a bug
 *  poisoned a class of keys). */
export const R2_CACHE_PREFIX = 'v1';

/** Packument TTL — matches FE/Build a private npm registry default. */
export const PACKUMENT_TTL_MS = 5 * 60_000;

/** Cap on tarball bytes returned via this RPC. Workerd structured-clone
 *  cap is 32 MiB; we keep a comfortable margin to leave room for RPC
 *  framing + the call's own arg bytes. Tarballs above this size skip
 *  the R2 path and go straight to the network — they're the long tail
 *  for which W7 (streams over RPC) will close the gap. */
export const MAX_R2_TARBALL_BYTES = 30 * 1024 * 1024;

// ── Types ───────────────────────────────────────────────────────────────

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
  put(
    key: string,
    body: Uint8Array | ArrayBuffer | string,
    opts?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
} | null;

// ── Key helpers ─────────────────────────────────────────────────────────

/**
 * Compose the R2 object key for a tarball.
 *
 * Scheme A from W4-plan §3: `t/<name>/<version>.tgz`. Scope-prefixed
 * names (`@scope/pkg`) keep their `@` and `/` because R2 keys allow any
 * UTF-8; we don't URL-encode them. Examples:
 *
 *   react@19.0.0                  → `v1/t/react/19.0.0.tgz`
 *   @vitejs/plugin-react@4.3.4    → `v1/t/@vitejs/plugin-react/4.3.4.tgz`
 *
 * The integrity digest is NOT in the key (Scheme B was rejected per
 * W4-plan §3; reads validate integrity post-fetch). Scheme A enables
 * pipelining: as soon as the resolver yields {name, version}, the
 * install facet can speculatively kick off getTarball() in parallel
 * with the network fetch.
 */
export function tarballKey(name: string, version: string): string {
  return `${R2_CACHE_PREFIX}/t/${name}/${version}.tgz`;
}

/** Compose the R2 object key for a packument. */
export function packumentKey(name: string): string {
  return `${R2_CACHE_PREFIX}/p/${name}.json`;
}

// ── Client ──────────────────────────────────────────────────────────────

/**
 * R2-backed npm cache client. Wraps two R2 bindings (tarballs + packuments)
 * with the get/put/delete shape the SupervisorRPC methods need.
 *
 * Constructed once per request-scope (typically inside SupervisorRPC
 * methods). Cheap to instantiate — no async init.
 *
 * ALL methods are null-bucket safe: pass `null` for either binding and
 * the corresponding read returns null / write is a no-op.
 */
export class R2CacheClient {
  constructor(
    private readonly tarballBucket: R2BucketLike,
    private readonly packumentBucket: R2BucketLike,
  ) {}

  /**
   * Get a cached tarball, or null if absent / oversize-bypassed.
   *
   * Returns the gzipped tar bytes as Uint8Array. Caller is responsible
   * for integrity verification before consuming — we do NOT verify here
   * because the caller (batch-facet) has the integrity hash from the
   * resolver's packument.
   */
  async getTarball(name: string, version: string): Promise<Uint8Array | null> {
    if (!this.tarballBucket) return null;
    const key = tarballKey(name, version);
    const obj = await this.tarballBucket.get(key);
    if (!obj) return null;
    const ab = await obj.arrayBuffer();
    if (ab.byteLength > MAX_R2_TARBALL_BYTES) {
      // Defense-in-depth: a bug or admin-uploaded oversized tarball
      // shouldn't blow the structured-clone cap on the way back to
      // the facet. Treat as miss; original install path will handle it.
      return null;
    }
    return new Uint8Array(ab);
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
  async putTarball(
    name: string,
    version: string,
    bytes: Uint8Array | ArrayBuffer,
  ): Promise<boolean> {
    if (!this.tarballBucket) return false;
    const size = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.length;
    if (size > MAX_R2_TARBALL_BYTES) return false;
    try {
      await this.tarballBucket.put(tarballKey(name, version), bytes, {
        httpMetadata: { contentType: 'application/gzip' },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Delete a single tarball cache entry. Idempotent. */
  async deleteTarball(name: string, version: string): Promise<boolean> {
    if (!this.tarballBucket) return false;
    try {
      await this.tarballBucket.delete(tarballKey(name, version));
      return true;
    } catch {
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
   */
  async getPackument(name: string): Promise<CachedPackument | null> {
    if (!this.packumentBucket) return null;
    const obj = await this.packumentBucket.get(packumentKey(name));
    if (!obj) return null;
    const json = await obj.text();
    const now = Date.now();
    const uploaded = obj.uploaded?.getTime() ?? now;
    const ageMs = Math.max(0, now - uploaded);
    const expiresAtRaw = obj.customMetadata?.expiresAt;
    const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : 0;
    const expired = expiresAt > 0
      ? now >= expiresAt
      : ageMs >= PACKUMENT_TTL_MS;
    return { json, ageMs, expired };
  }

  /**
   * Write a packument JSON to R2 with a TTL stamp in customMetadata.
   * No-op if the bucket binding is missing.
   *
   * Returns true on success, false on failure (same best-effort posture
   * as putTarball).
   */
  async putPackument(name: string, json: string): Promise<boolean> {
    if (!this.packumentBucket) return false;
    const expiresAt = Date.now() + PACKUMENT_TTL_MS;
    try {
      await this.packumentBucket.put(packumentKey(name), json, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { expiresAt: String(expiresAt) },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Delete a single packument cache entry. Idempotent. */
  async deletePackument(name: string): Promise<boolean> {
    if (!this.packumentBucket) return false;
    try {
      await this.packumentBucket.delete(packumentKey(name));
      return true;
    } catch {
      return false;
    }
  }

  /** Lightweight feature-detection for callers that want to log path. */
  hasTarballBucket(): boolean {
    return this.tarballBucket !== null;
  }

  /** Lightweight feature-detection for callers that want to log path. */
  hasPackumentBucket(): boolean {
    return this.packumentBucket !== null;
  }
}
