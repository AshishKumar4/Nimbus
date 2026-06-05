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
import { type VerifiedNimbusToken, type IssueTokenOptions } from './types.js';
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
export declare function issueNimbusToken(env: NimbusAuthEnv, input: {
    tn: string;
    sub?: string;
    scopes?: string[];
    sid?: string;
}, opts?: IssueTokenOptions): Promise<string>;
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
export declare function verifyNimbusToken(env: NimbusAuthEnv, token: string): Promise<VerifiedNimbusToken>;
//# sourceMappingURL=token.d.ts.map