/**
 * auth/middleware.ts — Request-time extract + verify glue.
 *
 * `extractBearerToken(request)` pulls the token from one of three places,
 * in order of precedence:
 *   1. `Authorization: Bearer <token>` header (canonical).
 *   2. `?nimbus_token=<token>` query parameter (for `<iframe src>`).
 *   3. `nimbus_token=<token>` cookie (for browser nav after the iframe
 *      sets it; the iframe can read its own cookie because cookies are
 *      scoped to the Nimbus origin, not the embedder's).
 *
 * The query/cookie fallbacks exist because `<iframe>` URLs are the
 * canonical embed shape for `<NimbusTerminal>` and browsers don't let
 * cross-origin iframes carry custom request headers on the initial
 * navigation request. The cookie path is used for post-load nav inside
 * the iframe (e.g. browser back/forward).
 *
 * NOTE: when the request comes from inside an `<iframe src="...?nimbus_token=...">`,
 * we set the cookie on the response so subsequent in-iframe navigations
 * don't need to re-pass the query param. See `setNimbusTokenCookie`.
 */
import { type NimbusAuthEnv } from './token.js';
import { type VerifiedNimbusToken } from './types.js';
/** Cookie name used for in-iframe token persistence. */
export declare const NIMBUS_TOKEN_COOKIE = "nimbus_token";
/** Query parameter name. */
export declare const NIMBUS_TOKEN_QUERY = "nimbus_token";
/**
 * Pull a token from a Request. Returns null if absent (caller decides
 * whether absence is an auth failure or just "anonymous").
 *
 * Precedence: Authorization header → query → cookie.
 */
export declare function extractBearerToken(request: Request): string | null;
/**
 * Verify a token from a Request. Convenience wrapper around
 * {@link extractBearerToken} + {@link verifyNimbusToken}.
 *
 * @throws {NimbusTokenMalformedError} when no token is present and
 *         `requireToken` is true (default).
 * @throws Any error from {@link verifyNimbusToken}.
 */
export declare function verifyRequestToken(request: Request, env: NimbusAuthEnv, opts?: {
    requireToken?: boolean;
}): Promise<VerifiedNimbusToken | null>;
/**
 * Assert that the verified token carries every required scope.
 *
 * Tokens with `scopes === undefined` are treated as "all permitted"
 * (legacy/full-trust). Tokens with an explicit `scopes` array must
 * contain every entry in `required`.
 *
 * @throws {NimbusScopeError} on the first missing scope.
 */
export declare function requireScopes(verified: VerifiedNimbusToken, required: readonly string[]): void;
/**
 * Assert that a sid-pinned token matches the session being attached. No-op
 * if the token isn't sid-pinned.
 *
 * @throws {NimbusSessionPinError} on mismatch.
 */
export declare function requireSessionPin(verified: VerifiedNimbusToken, attemptedSessionId: string): void;
/**
 * Build a Set-Cookie header value persisting the token in-iframe so
 * subsequent navigations don't need the `?nimbus_token=` query.
 *
 * Cookie attributes:
 *   - HttpOnly: NO — JS in the iframe shell needs to forward the token
 *     to its WebSocket via subprotocol. Keep this in mind for XSS posture
 *     (Nimbus's xterm shell never executes embedder JS, mitigating risk).
 *   - Secure: YES (production).
 *   - SameSite=None: required because the iframe is cross-origin from
 *     the embedder's app. Pairs with Secure.
 *   - Path: scoped to `/s/` so non-session paths don't see the cookie.
 *   - Max-Age: matches the token's remaining lifetime.
 */
export declare function setNimbusTokenCookie(token: string, expSec: number, opts?: {
    secure?: boolean;
}): string;
/**
 * Map a NimbusAuthError to a `Response` suitable for the embedder's
 * `fetch` handler to return. JSON body with `{ error, code }`.
 */
export declare function authErrorResponse(e: unknown): Response;
//# sourceMappingURL=middleware.d.ts.map