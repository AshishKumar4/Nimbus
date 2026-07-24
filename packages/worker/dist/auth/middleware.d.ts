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
 * navigation request. The router's attach exchange consumes the query
 * token, sets a sid-pinned attach cookie via `setNimbusTokenCookie`, and
 * redirects to the clean URL, so every subsequent HTML/WS/API request
 * authenticates via the cookie alone. It runs at two entry points:
 *   - `/s/<id>/` — the session shell, on the shell path only.
 *   - `<port>--<sid>.<suffix>/<any path>` — a port preview, where the
 *     previewed app owns the path space so the requested path is kept.
 */
import { type NimbusAuthEnv } from './token.js';
import { type VerifiedNimbusToken } from './types.js';
/**
 * Cookie name used for in-iframe token persistence.
 *
 * The `__Host-` prefix is load-bearing, not decoration: it makes the browser
 * refuse any `Set-Cookie` for this name that carries a `Domain` or a `Path`
 * other than `/`. Port previews serve untrusted user code on a subdomain of
 * this registrable domain, and without the prefix that code could set
 * `nimbus_token=<its own>; Domain=<apex>; Path=/s/` and shadow the real
 * cookie for the whole app (first match wins in the Cookie header).
 */
export declare const NIMBUS_TOKEN_COOKIE = "__Host-nimbus_token";
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
 * Build a Set-Cookie header value persisting the session attach token so
 * subsequent navigations don't need the `?nimbus_token=` query.
 *
 * Cookie attributes:
 *   - HttpOnly: YES — the shell's WebSocket and API requests are
 *     same-origin and carry the cookie automatically; no JS ever needs
 *     to read it.
 *   - Secure: YES (production).
 *   - SameSite=None: required because the iframe is cross-origin from
 *     the embedder's app. Pairs with Secure.
 *   - Partitioned: CHIPS — Chrome blocks unpartitioned third-party
 *     cookies, and the Nimbus iframe is third-party from the embedder's
 *     page. Set + read happen under the same top-level site, so a
 *     partitioned jar is exactly right. Requires Secure, so omitted on
 *     plain-HTTP local dev.
 *   - Path=/ and no Domain: mandated by the `__Host-` prefix, which is what
 *     keeps a preview subdomain from shadowing this cookie. One shape for
 *     both entry points — the preview host serves the app at its root, and
 *     the session shell's own paths are all under the same host anyway.
 *   - Max-Age: matches the token's remaining lifetime.
 */
export declare function setNimbusTokenCookie(token: string, expSec: number): string;
/**
 * Map a NimbusAuthError to a `Response` suitable for the embedder's
 * `fetch` handler to return. JSON body with `{ error, code }`.
 */
export declare function authErrorResponse(e: unknown): Response;
//# sourceMappingURL=middleware.d.ts.map