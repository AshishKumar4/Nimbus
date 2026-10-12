/**
 * auth/middleware.ts — Request-time extract + verify glue.
 *
 * `extractBearerToken(request, sessionId?)` pulls the token from one of three places,
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
import { type VerifiedNimbusRequestToken } from './types.js';
/**
 * Cookie name used for in-iframe token persistence.
 *
 * The `__Host-` prefix is load-bearing, not decoration: it makes the browser
 * refuse any `Set-Cookie` for this name that carries a `Domain` or a `Path`
 * other than `/`. Port previews serve untrusted user code on a subdomain of
 * this registrable domain, and without the prefix that code could set
 * `nimbus_token=<its own>; Domain=<apex>; Path=/s/` and shadow the real
 * cookie for the whole app (first match wins in the Cookie header).
 *
 * One jar, many sessions: each session route owns exactly
 * `__Host-nimbus_token-<sid>`, so two iframes on one page never overwrite
 * each other's attach credential. The sid in the name is validated exactly
 * like a route sid before the name is ever built; naming never replaces JWT
 * verification plus the sid pin for authentication.
 */
export declare const NIMBUS_TOKEN_COOKIE = "__Host-nimbus_token";
/** Prefix of every per-session attach cookie name (`${PREFIX}<sid>`). */
export declare const NIMBUS_TOKEN_COOKIE_PREFIX = "__Host-nimbus_token-";
/**
 * The cookie name for one already-validated session id. Callers must pass a
 * sid this request's route already parsed and validated; the guard here only
 * keeps a malformed value from ever becoming a cookie name.
 */
export declare function nimbusTokenCookieName(sessionId: string): string;
/** Query parameter name. */
export declare const NIMBUS_TOKEN_QUERY = "nimbus_token";
/**
 * Pull a token from a Request. Returns null if absent (caller decides
 * whether absence is an auth failure or just "anonymous").
 *
 * Precedence: Authorization header → query → cookie.
 */
/**
 * Pull a token from a Request for a route that already parsed its sid.
 * The route's own per-session cookie is the only cookie consulted; callers
 * with no session address (token minting, health) keep passing no sid and
 * consult no cookie at all.
 */
export declare function extractBearerToken(request: Request, sessionId?: string): string | null;
/**
 * Verify a token from a Request. Convenience wrapper around
 * {@link extractBearerToken} + {@link verifyNimbusToken}.
 *
 * @throws {NimbusTokenMalformedError} when no token is present and
 *         `requireToken` is true (default).
 * @throws Any error from {@link verifyNimbusToken}.
 */
export declare function verifyRequestToken(request: Request, env: NimbusAuthEnv): Promise<VerifiedNimbusRequestToken>;
export declare function verifyRequestToken(request: Request, env: NimbusAuthEnv, opts: {
    requireToken: true;
    sessionId?: string;
}): Promise<VerifiedNimbusRequestToken>;
export declare function verifyRequestToken(request: Request, env: NimbusAuthEnv, opts: {
    requireToken?: boolean;
    sessionId?: string;
}): Promise<VerifiedNimbusRequestToken | null>;
/**
 * Authorize a request for a route: verify its token, require every scope in
 * `scopes`, and, on a route that addresses a session, require the token's
 * pin to match it. Throws the NimbusAuthError of the first check that fails;
 * each route keeps its own legacy policy and error envelope.
 */
export declare function authorizeRequest(request: Request, env: NimbusAuthEnv, required: {
    scopes: readonly string[];
    sessionId?: string;
}): Promise<VerifiedNimbusRequestToken>;
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
export declare function setNimbusTokenCookie(token: string, expSec: number, sessionId: string): string;
/**
 * Expire the pre-per-session legacy cookie after a migration: once a route
 * authenticates its own credential, the ambiguous global name must not linger
 * to be selected again.
 */
export declare function expireLegacyNimbusTokenCookie(): string;
/**
 * Migration headers for a request that authenticated via the legacy global
 * cookie: re-issue its verified token under the route-owned name and expire
 * the legacy name, in the same response. Returns [] unless the jar holds the
 * legacy name but NOT the route-owned one — a jar that already migrated, or
 * that never had the legacy credential, gets no extra bytes. The re-issued
 * token keeps its verified expiry; this never mints, never extends, never
 * consults anything but the already-verified claims.
 */
export declare function sessionCookieMigration(requestCookie: string | null, verified: VerifiedNimbusRequestToken, sessionId: string): string[];
/**
 * Largest attach-cookie jar an exchange will grow: at most this many
 * per-session names, and the request's Cookie header plus the new
 * `Set-Cookie` bytes stay under this many bytes in total. Sessions
 * accumulate (one name each, never evicted), so issuance stops before the
 * jar would push a browser past its per-request header ceiling; the
 * caller retries from a fresh profile or prunes dead sessions first.
 */
export declare const NIMBUS_TOKEN_COOKIE_LIMIT = 24;
export declare const NIMBUS_TOKEN_COOKIE_HEADER_LIMIT: number;
export declare const NIMBUS_TOKEN_SET_COOKIE_LIMIT = 4096;
/** Chrome's name/value quota per CHIPS partition and registrable domain. */
export declare const NIMBUS_TOKEN_PARTITION_BYTES_LIMIT = 10240;
/**
 * Refuse an exchange that would overflow the browser's cookie jar.
 * Runs before any single-use bootstrap is consumed, so a refusal never
 * burns a one-shot credential. Eviction is never an option: dropping a
 * sibling session's credential to make room would be the same ownership
 * bug in reverse.
 */
export declare function enforceSessionCookieCapacity(cookieHeader: string | null, proposedCookie: string, expireLegacy?: boolean): void;
/**
 * Map a NimbusAuthError to a `Response` suitable for the embedder's
 * `fetch` handler to return. JSON body with `{ error, code }`.
 */
export declare function authErrorResponse(e: unknown): Response;
//# sourceMappingURL=middleware.d.ts.map