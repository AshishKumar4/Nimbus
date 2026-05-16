/**
 * auth/types.ts — Public-facing types for the Nimbus auth surface.
 *
 * Two consumers:
 *   1. The Worker (`@nimbus-sh/worker`) — reads `verifyNimbusToken` results
 *      to gate `/s/<id>/` routes and pin DO instance names per-tenant.
 *   2. The SDK (`@nimbus-sh/sdk`) — re-exports `issueNimbusToken` so an
 *      embedder's Worker (or CLI) can mint tokens from a JWT secret.
 *
 * The on-the-wire shape is a JWS with HS256 signature, base64url-encoded:
 *
 *   <header>.<payload>.<signature>
 *
 * where the payload is a `NimbusTokenClaims` JSON object below. The header
 * is the constant `{"alg":"HS256","typ":"JWT"}` — we don't permit alg
 * variation (no `alg: "none"` confusion attack; we never read the header's
 * `alg`).
 */

/**
 * Claims encoded inside the JWT payload. Mirrors Mossaic's `{scope, ns, tn,
 * sub?, sid?, iat, exp}` exactly except:
 *   - `scope` is the literal string `"nimbus"`. Cross-product tokens
 *     (e.g. a Mossaic VFS token) MUST be rejected by Nimbus's verifier.
 *   - `tn` is the tenant. Required. Maps to the `tenant` portion of the
 *     DO instance name. Per `[A-Za-z0-9._-]{1,128}` (validated at verify).
 *   - `sub` is the user/principal within the tenant. Optional; when
 *     absent, treated as `"_"` for DO naming (i.e. the tenant-default
 *     user).
 *   - `scopes` is an optional array of capability strings the token
 *     grants. v1 honors `"session:create"`, `"session:attach"`,
 *     `"session:admin"`. Absent = all permitted (backward compat for
 *     legacy tokens).
 *   - `sid` is an optional session-pin: when present, the token may only
 *     attach to that single session. When absent, the token may attach
 *     to any session for `(tn, sub)`.
 *   - `iat` / `exp` are UNIX seconds (NumericDate per RFC 7519).
 */
export interface NimbusTokenClaims {
  /** MUST be the literal `"nimbus"`. Discriminator vs Mossaic / other JWTs. */
  scope: 'nimbus';
  /** Tenant identifier. `[A-Za-z0-9._-]{1,128}`. */
  tn: string;
  /** Subject (user). Optional; absent = tenant-default. `[A-Za-z0-9._-]{1,128}`. */
  sub?: string;
  /** Capability scopes. Absent = legacy "all permitted". */
  scopes?: string[];
  /** Session-pin: token only valid for this session. Optional. */
  sid?: string;
  /** Issued-at (UNIX seconds). */
  iat: number;
  /** Expiry (UNIX seconds). */
  exp: number;
}

/** Default token TTL when `issueNimbusToken` is called without `ttlMs`. 1 hour. */
export const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Maximum permitted token TTL. 30 days. Prevents accidental long-lived secrets. */
export const MAX_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Result of a successful `verifyNimbusToken` call. Verified claims plus a
 * canonical DO instance-naming string derived from `(tn, sub || '_')`.
 *
 * Consumers should prefer `doInstanceName` over re-deriving from `claims`
 * — the verifier is the single source of truth for sub-defaulting.
 */
export interface VerifiedNimbusToken {
  /** The verified claims, unchanged from the wire format. */
  claims: NimbusTokenClaims;
  /** `${tn}:${sub || '_'}` — feed to `idFromName` after appending sessionId. */
  doInstanceName: string;
}

/**
 * Options for `issueNimbusToken`. All optional.
 *
 * `ttlMs` defaults to {@link DEFAULT_TOKEN_TTL_MS}. Values > {@link
 * MAX_TOKEN_TTL_MS} throw `NimbusAuthError` with `code: 'TTL_TOO_LARGE'`.
 */
export interface IssueTokenOptions {
  ttlMs?: number;
  /** Override `iat`. Useful in tests to assert exp arithmetic. */
  iatOverride?: number;
}

/**
 * Base error class for every auth-layer failure. Subclasses encode the
 * specific failure mode in `code`.
 *
 * Why a class hierarchy instead of an `{ ok: false, code }` union? Two
 * reasons: (1) embedders' error handlers naturally use `try/catch`, and
 * an exception flow propagates without ceremony; (2) consumers in
 * non-TypeScript environments (a Node SSR layer minting tokens) still
 * get `error.code` introspection.
 *
 * Every subclass below is INSTANCEOF-compatible with this base, so a
 * blanket `catch (e instanceof NimbusAuthError)` works.
 */
export class NimbusAuthError extends Error {
  /** Machine-readable code for catch sites. Subclass-stable. */
  readonly code: string;
  /** HTTP status the embedder's auth gate should map to (typically 401). */
  readonly httpStatus: number;
  constructor(message: string, code: string, httpStatus: number = 401) {
    super(message);
    this.name = 'NimbusAuthError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Thrown when JWT_SECRET env var is missing at issue/verify time. */
export class NimbusAuthConfigError extends NimbusAuthError {
  constructor(message: string = 'JWT_SECRET is not configured') {
    super(message, 'E_AUTH_CONFIG_MISSING', 500);
    this.name = 'NimbusAuthConfigError';
  }
}

/** Thrown when the token shape is structurally invalid (not 3 parts, bad b64). */
export class NimbusTokenMalformedError extends NimbusAuthError {
  constructor(reason: string) {
    super(`Malformed token: ${reason}`, 'E_TOKEN_MALFORMED');
    this.name = 'NimbusTokenMalformedError';
  }
}

/** Thrown when the HMAC signature does not verify against JWT_SECRET. */
export class NimbusTokenSignatureError extends NimbusAuthError {
  constructor() {
    super('Token signature invalid', 'E_TOKEN_SIGNATURE');
    this.name = 'NimbusTokenSignatureError';
  }
}

/** Thrown when claims fail validation (missing scope, bad tn shape, etc.). */
export class NimbusTokenClaimsError extends NimbusAuthError {
  constructor(reason: string) {
    super(`Invalid claims: ${reason}`, 'E_TOKEN_CLAIMS');
    this.name = 'NimbusTokenClaimsError';
  }
}

/** Thrown when `exp` is in the past (with no clock skew tolerance — strict). */
export class NimbusTokenExpiredError extends NimbusAuthError {
  /** Seconds the token expired ago (always ≥ 0). */
  readonly expiredAgoSec: number;
  constructor(expiredAgoSec: number) {
    super(`Token expired ${expiredAgoSec}s ago`, 'E_TOKEN_EXPIRED');
    this.name = 'NimbusTokenExpiredError';
    this.expiredAgoSec = expiredAgoSec;
  }
}

/** Thrown when issue-time ttl exceeds {@link MAX_TOKEN_TTL_MS}. */
export class NimbusTokenTtlError extends NimbusAuthError {
  constructor(ttlMs: number, maxMs: number) {
    super(
      `Token TTL ${ttlMs}ms exceeds maximum ${maxMs}ms`,
      'E_TOKEN_TTL_TOO_LARGE',
      400,
    );
    this.name = 'NimbusTokenTtlError';
  }
}

/** Thrown when a route requires a scope the token doesn't carry. */
export class NimbusScopeError extends NimbusAuthError {
  readonly requiredScope: string;
  constructor(requiredScope: string) {
    super(`Missing required scope: ${requiredScope}`, 'E_SCOPE_MISSING', 403);
    this.name = 'NimbusScopeError';
    this.requiredScope = requiredScope;
  }
}

/** Thrown when sid-pin doesn't match the actual session being attached. */
export class NimbusSessionPinError extends NimbusAuthError {
  readonly pinnedTo: string;
  readonly attempted: string;
  constructor(pinnedTo: string, attempted: string) {
    super(
      `Token pinned to session "${pinnedTo}" but request targets "${attempted}"`,
      'E_SESSION_PIN_MISMATCH',
      403,
    );
    this.name = 'NimbusSessionPinError';
    this.pinnedTo = pinnedTo;
    this.attempted = attempted;
  }
}

/** Regex used to validate the `tn` and `sub` shape (per Mossaic §7.1). */
export const ID_COMPONENT_RE = /^[A-Za-z0-9._-]{1,128}$/;
