/**
 * auth/token.ts — HS256 JWT issue + verify via WebCrypto subtle.
 *
 * Why HS256 (not RS256/ES256, not OAuth introspection)?
 *   - Embedder and Nimbus share `JWT_SECRET` via `wrangler secret put`.
 *     No external IDP needed; works on day-1 for any Workers project.
 *   - HMAC is constant-time-comparable, supported natively by WebCrypto,
 *     and zero-dependency.
 *   - Pattern matches Mossaic exactly — port surface (`scope`, `tn`,
 *     `sub?`, `sid?`, `iat`, `exp`) is identical except the `scope` value.
 *
 * Why WebCrypto over `jose`?
 *   - One fewer dependency in the SDK package. `jose` is great but pulls
 *     in ~70 KB of code for features we don't use (RSA, EC, JWE, JWK).
 *   - `crypto.subtle.{importKey,sign,verify}` is available identically in
 *     workerd, Node ≥ 18, and modern browsers. Test parity is excellent.
 *
 * Wire format:
 *
 *   <b64url(header)>.<b64url(payload)>.<b64url(hmacSha256(secret, ".".join(...)))>
 *
 * `header` is constant `{"alg":"HS256","typ":"JWT"}`. We never read alg
 * from the header at verify-time (eliminates the `alg: "none"` confusion
 * attack class — see RFC 8725 §3.1).
 */

import {
  DEFAULT_TOKEN_TTL_MS,
  MAX_TOKEN_TTL_MS,
  ID_COMPONENT_RE,
  NimbusAuthConfigError,
  NimbusTokenMalformedError,
  NimbusTokenSignatureError,
  NimbusTokenClaimsError,
  NimbusTokenExpiredError,
  NimbusTokenTtlError,
  type NimbusTokenClaims,
  type VerifiedNimbusToken,
  type IssueTokenOptions,
} from './types.js';

/** Constant JWT header. Serialized at module load; we just splice the cached b64. */
const HEADER_JSON = '{"alg":"HS256","typ":"JWT"}';
const HEADER_B64 = b64urlEncodeString(HEADER_JSON);

/**
 * The minimum env shape required by issue/verify. Embedders typically use
 * `Env extends NimbusAuthEnv & ...other-bindings...` to compose.
 */
export interface NimbusAuthEnv {
  /** HMAC secret. Set via `wrangler secret put JWT_SECRET`. */
  JWT_SECRET: string;
  /**
   * Optional previous-generation secret for rotation. When set, verify
   * accepts tokens signed by either. Issue always uses the primary.
   */
  JWT_SECRET_PREVIOUS?: string;
}

/**
 * Mint a Nimbus JWT.
 *
 * @example Mint a 1-hour session token for a tenant user.
 * ```ts
 * import { issueNimbusToken } from '@nimbus-sh/sdk/token';
 * const token = await issueNimbusToken(env, { tn: 'acme', sub: 'alice' });
 * ```
 *
 * @example Mint an admin token with `session:admin` scope, 24 hours.
 * ```ts
 * const token = await issueNimbusToken(
 *   env,
 *   { tn: 'acme', sub: 'ops', scopes: ['session:admin'] },
 *   { ttlMs: 24 * 60 * 60 * 1000 },
 * );
 * ```
 *
 * @param env Object with at least `JWT_SECRET`.
 * @param input Claims-without-iat/exp/scope. `scope` is set to `"nimbus"`
 *              by this function; do not pass it in.
 * @param opts Optional `ttlMs` (default {@link DEFAULT_TOKEN_TTL_MS}, max
 *             {@link MAX_TOKEN_TTL_MS}) and `iatOverride` (tests only).
 *
 * @throws {NimbusAuthConfigError} when `env.JWT_SECRET` is missing/empty.
 * @throws {NimbusTokenClaimsError} when `tn`/`sub` shape is invalid.
 * @throws {NimbusTokenTtlError} when `opts.ttlMs` > {@link MAX_TOKEN_TTL_MS}.
 */
export async function issueNimbusToken(
  env: NimbusAuthEnv,
  input: {
    tn: string;
    sub?: string;
    scopes?: string[];
    sid?: string;
  },
  opts: IssueTokenOptions = {},
): Promise<string> {
  if (!env || typeof env.JWT_SECRET !== 'string' || env.JWT_SECRET.length === 0) {
    throw new NimbusAuthConfigError(
      'JWT_SECRET is not configured (set via `wrangler secret put JWT_SECRET`)',
    );
  }
  if (!ID_COMPONENT_RE.test(input.tn)) {
    throw new NimbusTokenClaimsError(
      `tn must match ${ID_COMPONENT_RE} (got: ${JSON.stringify(input.tn)})`,
    );
  }
  if (input.sub !== undefined && !ID_COMPONENT_RE.test(input.sub)) {
    throw new NimbusTokenClaimsError(
      `sub must match ${ID_COMPONENT_RE} (got: ${JSON.stringify(input.sub)})`,
    );
  }
  if (input.sid !== undefined && !ID_COMPONENT_RE.test(input.sid)) {
    throw new NimbusTokenClaimsError(
      `sid must match ${ID_COMPONENT_RE} (got: ${JSON.stringify(input.sid)})`,
    );
  }
  const ttlMs = opts.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
  if (ttlMs <= 0) {
    throw new NimbusTokenTtlError(ttlMs, MAX_TOKEN_TTL_MS);
  }
  if (ttlMs > MAX_TOKEN_TTL_MS) {
    throw new NimbusTokenTtlError(ttlMs, MAX_TOKEN_TTL_MS);
  }

  const iat = opts.iatOverride ?? Math.floor(Date.now() / 1000);
  const exp = iat + Math.floor(ttlMs / 1000);

  const claims: NimbusTokenClaims = {
    scope: 'nimbus',
    tn: input.tn,
    ...(input.sub !== undefined && { sub: input.sub }),
    ...(input.scopes !== undefined && { scopes: input.scopes }),
    ...(input.sid !== undefined && { sid: input.sid }),
    iat,
    exp,
  };

  const payloadB64 = b64urlEncodeString(JSON.stringify(claims));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const sig = await hmacSha256(env.JWT_SECRET, signingInput);
  return `${signingInput}.${b64urlEncodeBytes(sig)}`;
}

/**
 * Verify a Nimbus JWT and return the parsed claims + canonical DO name.
 *
 * @example Verify a token at request-time.
 * ```ts
 * import { verifyNimbusToken } from '@nimbus-sh/sdk/token';
 * const { claims, doInstanceName } = await verifyNimbusToken(env, token);
 * // → idFromName(`${doInstanceName}:${sessionId}`)
 * ```
 *
 * @param env Object with `JWT_SECRET` and optional `JWT_SECRET_PREVIOUS`.
 * @param token Raw JWT string (no `Bearer ` prefix — caller strips that).
 *
 * @throws {NimbusAuthConfigError} when `env.JWT_SECRET` is missing.
 * @throws {NimbusTokenMalformedError} when token is not 3 b64 parts.
 * @throws {NimbusTokenSignatureError} when HMAC verify fails for both
 *         primary and previous secrets.
 * @throws {NimbusTokenClaimsError} when payload fields are missing or
 *         shape-invalid.
 * @throws {NimbusTokenExpiredError} when `exp` < `now`.
 */
export async function verifyNimbusToken(
  env: NimbusAuthEnv,
  token: string,
): Promise<VerifiedNimbusToken> {
  if (!env || typeof env.JWT_SECRET !== 'string' || env.JWT_SECRET.length === 0) {
    throw new NimbusAuthConfigError(
      'JWT_SECRET is not configured (set via `wrangler secret put JWT_SECRET`)',
    );
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new NimbusTokenMalformedError('token must be a non-empty string');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new NimbusTokenMalformedError(
      `expected 3 dot-separated parts, got ${parts.length}`,
    );
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  // Verify against primary, then previous (for rotation windows).
  const sigBytes = b64urlDecodeBytes(sigB64);
  const okPrimary = await hmacVerify(env.JWT_SECRET, signingInput, sigBytes);
  if (!okPrimary) {
    if (env.JWT_SECRET_PREVIOUS) {
      const okPrev = await hmacVerify(env.JWT_SECRET_PREVIOUS, signingInput, sigBytes);
      if (!okPrev) throw new NimbusTokenSignatureError();
    } else {
      throw new NimbusTokenSignatureError();
    }
  }

  // Decode + claim-shape validate.
  let claims: NimbusTokenClaims;
  try {
    claims = JSON.parse(b64urlDecodeString(payloadB64));
  } catch (e: any) {
    throw new NimbusTokenMalformedError(`payload is not valid JSON: ${e?.message || e}`);
  }
  if (claims === null || typeof claims !== 'object') {
    throw new NimbusTokenClaimsError('payload is not a JSON object');
  }
  if (claims.scope !== 'nimbus') {
    throw new NimbusTokenClaimsError(
      `scope must be "nimbus" (got: ${JSON.stringify(claims.scope)})`,
    );
  }
  if (typeof claims.tn !== 'string' || !ID_COMPONENT_RE.test(claims.tn)) {
    throw new NimbusTokenClaimsError(`tn is missing or invalid`);
  }
  if (claims.sub !== undefined && (typeof claims.sub !== 'string' || !ID_COMPONENT_RE.test(claims.sub))) {
    throw new NimbusTokenClaimsError(`sub shape invalid`);
  }
  if (claims.sid !== undefined && (typeof claims.sid !== 'string' || !ID_COMPONENT_RE.test(claims.sid))) {
    throw new NimbusTokenClaimsError(`sid shape invalid`);
  }
  if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') {
    throw new NimbusTokenClaimsError(`iat and exp must be numbers (NumericDate)`);
  }
  if (claims.scopes !== undefined) {
    if (!Array.isArray(claims.scopes) || claims.scopes.some((s) => typeof s !== 'string')) {
      throw new NimbusTokenClaimsError(`scopes must be an array of strings`);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.exp < nowSec) {
    throw new NimbusTokenExpiredError(nowSec - claims.exp);
  }

  return {
    claims,
    doInstanceName: `${claims.tn}:${claims.sub ?? '_'}`,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────

/**
 * HMAC-SHA-256 sign via WebCrypto subtle. Returns raw signature bytes.
 *
 * The CryptoKey is created on each call. workerd's subtle is cheap enough
 * that caching would only matter at >10K signs/sec; we're at single-digit
 * per request.
 */
async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

/** Constant-time verify via `crypto.subtle.verify` (no manual loop needed). */
async function hmacVerify(
  secret: string,
  data: string,
  expected: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, expected as BufferSource, new TextEncoder().encode(data));
}

/** base64url-encode a UTF-8 string. No padding. */
function b64urlEncodeString(s: string): string {
  return b64urlEncodeBytes(new TextEncoder().encode(s));
}

/** base64url-encode raw bytes. No padding (per RFC 7515 §2). */
function b64urlEncodeBytes(bytes: Uint8Array): string {
  // workerd has btoa; convert bytes -> binary string -> btoa -> url-safe -> strip pad.
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url-decode to a UTF-8 string. */
function b64urlDecodeString(s: string): string {
  return new TextDecoder().decode(b64urlDecodeBytes(s));
}

/** base64url-decode to raw bytes. */
function b64urlDecodeBytes(s: string): Uint8Array {
  // Re-pad to a multiple of 4 + restore +/.
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (padded.length % 4)) % 4;
  const padStr = padded + '='.repeat(pad);
  const binary = atob(padStr);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
