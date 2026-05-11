/**
 * auth/api-keys.ts — KeyRegistry: persistent storage + validation of
 * API keys, layered over a DurableObjectStorage instance.
 *
 * This class lives in the AUTH DO (singleton at well-known ID
 * `__nimbus_auth__`) and is consumed via its DO interface — never
 * instantiated cross-DO directly.
 *
 * Storage layout (see auth/shared.ts):
 *   auth_key:<keyId>            → ApiKeyRecord
 *   auth_key_idx:<sha256-hex>   → keyId
 *
 * The full sha256 is used as the index key (not a prefix) so there is
 * no plaintext-collision footgun. Lookup by hashed key is O(1).
 *
 * Rate limiting lives here too — in-memory only, per registry instance
 * (which means per DO isolate). On isolate restart the buckets reset
 * to full capacity. This is acceptable for v1 because supervisor-DO
 * isolate lifetimes are minutes-to-hours; persisted counters land in
 * Wave AGT-3.3.
 */

import {
  type ApiKeyRecord,
  type ApiKeyView,
  type CreateKeyResponse,
  generateKey,
  generateKeyId,
  hashKey,
} from './shared.js';

/** Storage prefix for ApiKeyRecord rows. */
const KEY_PREFIX = 'auth_key:';
/** Storage prefix for hashed-key index rows. Value = keyId. */
const IDX_PREFIX = 'auth_key_idx:';

/** Rate-limit defaults. Tunable later via a single env var if needed. */
const RATE_LIMIT_TOKENS_PER_MIN = 1000;
const RATE_LIMIT_REFILL_PER_MS = RATE_LIMIT_TOKENS_PER_MIN / 60_000;
const RATE_LIMIT_BUCKET_CAPACITY = RATE_LIMIT_TOKENS_PER_MIN;

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

/** What `validate()` returns to the middleware. */
export type ValidateResult =
  | { kind: 'ok'; keyId: string; record: ApiKeyRecord }
  | { kind: 'rate-limited'; keyId: string; retryAfterMs: number }
  | { kind: 'invalid' }
  | { kind: 'revoked'; keyId: string };

export class KeyRegistry {
  private readonly storage: DurableObjectStorage;
  private readonly buckets = new Map<string, RateBucket>();

  /**
   * Positive-result cache (60s TTL) — keyed by sha256 of plaintext.
   * Negative results NEVER cached so revocation is immediate.
   */
  private readonly hotCache = new Map<string, { record: ApiKeyRecord; expiresAt: number }>();
  private static readonly HOT_TTL_MS = 60_000;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }

  /** Create a new key. Returns the plaintext exactly once. */
  async create(name: string, ownerEmail?: string): Promise<CreateKeyResponse> {
    const key = generateKey();
    const keyId = generateKeyId();
    const hashedKey = await hashKey(key);
    const record: ApiKeyRecord = {
      keyId,
      hashedKey,
      name: String(name || '').slice(0, 256),
      ownerEmail: ownerEmail ? String(ownerEmail).slice(0, 256) : undefined,
      createdAt: Date.now(),
      lastUsedAt: 0,
    };
    // Write both rows in one transaction.
    await this.storage.transaction(async (tx) => {
      await tx.put(KEY_PREFIX + keyId, record);
      await tx.put(IDX_PREFIX + hashedKey, keyId);
    });
    return { keyId, key };
  }

  /** List all keys (excluding plaintext). Sorted by createdAt ascending. */
  async list(): Promise<ApiKeyView[]> {
    const rows = await this.storage.list<ApiKeyRecord>({ prefix: KEY_PREFIX });
    const out: ApiKeyView[] = [];
    for (const [, rec] of rows) {
      // Strip hashedKey from the public view.
      const { hashedKey: _drop, ...view } = rec;
      out.push(view);
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  /**
   * Revoke a key by its keyId. Sets revokedAt on the record; leaves the
   * index row in place so the validate() path sees the revocation
   * (returning { kind: 'revoked' }).
   * Returns true if a row was updated, false if no such key.
   */
  async revoke(keyId: string): Promise<boolean> {
    const rec = await this.storage.get<ApiKeyRecord>(KEY_PREFIX + keyId);
    if (!rec) return false;
    if (rec.revokedAt) return true; // already revoked, idempotent
    rec.revokedAt = Date.now();
    await this.storage.put(KEY_PREFIX + keyId, rec);
    // Invalidate hot cache entry so revocation is immediate.
    this.hotCache.delete(rec.hashedKey);
    return true;
  }

  /**
   * Validate a plaintext key. Returns one of:
   *   - { kind: 'ok', keyId, record } — bumped lastUsedAt + decremented rate limit token
   *   - { kind: 'rate-limited', keyId, retryAfterMs } — bucket empty
   *   - { kind: 'invalid' } — no such key
   *   - { kind: 'revoked', keyId } — found but revoked
   *
   * `lastUsedAt` update is fire-and-forget (we don't await the put)
   * to keep the hot path tight; worst case a request bump is lost on
   * isolate restart.
   */
  async validate(plaintext: string): Promise<ValidateResult> {
    if (!plaintext || typeof plaintext !== 'string') return { kind: 'invalid' };
    if (!plaintext.startsWith('nimbus_')) return { kind: 'invalid' };

    const hashed = await hashKey(plaintext);

    // Hot cache lookup — positive results only.
    const now = Date.now();
    const hit = this.hotCache.get(hashed);
    let rec: ApiKeyRecord | null = null;
    if (hit && hit.expiresAt > now) {
      rec = hit.record;
    } else {
      this.hotCache.delete(hashed);
      const keyId = await this.storage.get<string>(IDX_PREFIX + hashed);
      if (!keyId) return { kind: 'invalid' };
      const r = await this.storage.get<ApiKeyRecord>(KEY_PREFIX + keyId);
      if (!r) return { kind: 'invalid' }; // index without row = stale; treat as invalid
      rec = r;
    }

    if (rec.revokedAt) {
      return { kind: 'revoked', keyId: rec.keyId };
    }

    // Rate limit check (in-memory; per-isolate).
    const bucket = this.refill(rec.keyId, now);
    if (bucket.tokens < 1) {
      const retryAfterMs = Math.ceil((1 - bucket.tokens) / RATE_LIMIT_REFILL_PER_MS);
      return { kind: 'rate-limited', keyId: rec.keyId, retryAfterMs };
    }
    bucket.tokens -= 1;

    // Populate hot cache.
    this.hotCache.set(hashed, { record: rec, expiresAt: now + KeyRegistry.HOT_TTL_MS });

    // Best-effort lastUsedAt bump. Only write if it has been >60s
    // since last update to avoid storage thrash on bursts.
    if (now - rec.lastUsedAt > 60_000) {
      rec.lastUsedAt = now;
      // Fire-and-forget. ctx.waitUntil isn't reachable here; the
      // microtask will land before the DO finishes its turn.
      this.storage.put(KEY_PREFIX + rec.keyId, rec).catch(() => {});
    }

    return { kind: 'ok', keyId: rec.keyId, record: rec };
  }

  /** Refill the rate-limit bucket for a key. Returns the (mutated) bucket. */
  private refill(keyId: string, now: number): RateBucket {
    let bucket = this.buckets.get(keyId);
    if (!bucket) {
      bucket = { tokens: RATE_LIMIT_BUCKET_CAPACITY, lastRefill: now };
      this.buckets.set(keyId, bucket);
      return bucket;
    }
    const dt = now - bucket.lastRefill;
    if (dt > 0) {
      bucket.tokens = Math.min(
        RATE_LIMIT_BUCKET_CAPACITY,
        bucket.tokens + dt * RATE_LIMIT_REFILL_PER_MS,
      );
      bucket.lastRefill = now;
    }
    return bucket;
  }
}
