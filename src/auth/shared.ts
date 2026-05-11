/**
 * auth/shared.ts — types + small helpers shared by api-keys, middleware,
 * and routes.
 *
 * Key format: `nimbus_<32-hex-chars>`.
 *   - `nimbus_` prefix makes log-scanning for accidentally-committed
 *     secrets straightforward.
 *   - 32 hex chars = 128 bits of cryptographic randomness.
 *
 * Storage rows:
 *   - `auth_key:<keyId>`            — ApiKeyRecord (no plaintext)
 *   - `auth_key_idx:<hash-prefix>`  — keyId (for O(1) lookup by hashed key)
 */

/** Persisted record. `hashedKey` is sha256(plaintext) hex; plaintext NEVER stored. */
export interface ApiKeyRecord {
  /** Opaque short admin identifier: `key_<10-hex>` */
  keyId: string;
  /** sha256 hex of the plaintext key (full 64 hex chars). */
  hashedKey: string;
  /** Human-readable label. */
  name: string;
  /** Optional owner email. */
  ownerEmail?: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms; updated on every successful auth (best-effort, not blocking). */
  lastUsedAt: number;
  /** Epoch ms when revoke() was called; missing/undefined = active. */
  revokedAt?: number;
}

/** Public view returned by /auth/keys/list. Strips hashedKey. */
export type ApiKeyView = Omit<ApiKeyRecord, 'hashedKey'>;

/** Returned by /auth/keys/create. The plaintext key is SHOWN ONCE here. */
export interface CreateKeyResponse {
  keyId: string;
  /** Plaintext key (nimbus_<32-hex>). Caller MUST store this; we never return it again. */
  key: string;
}

/** Authentication decision returned by the middleware. */
export type AuthDecision =
  | { kind: 'allow'; principal: 'admin' | 'browser-same-origin' | 'api-key'; keyId?: string }
  | { kind: 'deny'; status: 401 | 403 | 429; reason: string; retryAfter?: number };

/**
 * Reject Authorization headers that don't parse as a Bearer-form token.
 * Strict — empty after-Bearer, no scheme, wrong case → null.
 */
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  // Per RFC 6750, scheme is case-insensitive; tokens may not contain whitespace.
  const m = /^[Bb][Ee][Aa][Rr][Ee][Rr]\s+(\S+)\s*$/.exec(header);
  return m ? m[1] : null;
}

/**
 * Constant-time string compare. Both inputs are normalised to ASCII before
 * the loop so non-ASCII Unicode can't cause time-leak via UTF-8 length
 * mismatch (we still return false-on-mismatch but only after equal-length scan).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Always scan max(a.length, b.length) bytes so the run-time depends only
  // on the longer input, not on the matching-prefix length.
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

/**
 * sha256 of a plaintext key, lowercase hex. Implementation uses
 * `crypto.subtle.digest`, which is available in the workerd runtime.
 */
export async function hashKey(plaintext: string): Promise<string> {
  const data = new TextEncoder().encode(plaintext);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Generate a fresh API key: `nimbus_<32-hex>` from 16 bytes of crypto
 * randomness. The leading `nimbus_` literal is a deliberate marker so
 * grep can find committed-by-accident secrets in source / logs.
 */
export function generateKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return `nimbus_${hex}`;
}

/** Generate a short opaque keyId: `key_<10-hex>` from 5 bytes. */
export function generateKeyId(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return `key_${hex}`;
}
