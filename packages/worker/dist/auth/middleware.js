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
import { verifyNimbusToken } from './token.js';
import { NimbusAuthError, NimbusTokenMalformedError, NimbusScopeError, NimbusSessionPinError, } from './types.js';
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
export const NIMBUS_TOKEN_COOKIE = '__Host-nimbus_token';
/** Query parameter name. */
export const NIMBUS_TOKEN_QUERY = 'nimbus_token';
/**
 * Pull a token from a Request. Returns null if absent (caller decides
 * whether absence is an auth failure or just "anonymous").
 *
 * Precedence: Authorization header → query → cookie.
 */
export function extractBearerToken(request) {
    // 1. Authorization header.
    const auth = request.headers.get('Authorization');
    if (auth) {
        const m = auth.match(/^Bearer\s+(.+)$/i);
        if (m)
            return m[1];
    }
    // 2. Query parameter.
    const url = new URL(request.url);
    const q = url.searchParams.get(NIMBUS_TOKEN_QUERY);
    if (q && q.length > 0)
        return q;
    // 3. Cookie.
    const cookie = request.headers.get('Cookie');
    if (cookie) {
        for (const c of cookie.split(';')) {
            const [k, v] = c.trim().split('=', 2);
            if (k === NIMBUS_TOKEN_COOKIE && v)
                return decodeURIComponent(v);
        }
    }
    return null;
}
/**
 * Verify a token from a Request. Convenience wrapper around
 * {@link extractBearerToken} + {@link verifyNimbusToken}.
 *
 * @throws {NimbusTokenMalformedError} when no token is present and
 *         `requireToken` is true (default).
 * @throws Any error from {@link verifyNimbusToken}.
 */
export async function verifyRequestToken(request, env, opts = {}) {
    const token = extractBearerToken(request);
    if (!token) {
        if (opts.requireToken === false)
            return null;
        throw new NimbusTokenMalformedError('no Bearer token in Authorization header, nimbus_token query, or cookie');
    }
    return verifyNimbusToken(env, token);
}
/**
 * Assert that the verified token carries every required scope.
 *
 * Tokens with `scopes === undefined` are treated as "all permitted"
 * (legacy/full-trust). Tokens with an explicit `scopes` array must
 * contain every entry in `required`.
 *
 * @throws {NimbusScopeError} on the first missing scope.
 */
export function requireScopes(verified, required) {
    if (verified.claims.scopes === undefined)
        return;
    for (const r of required) {
        if (!verified.claims.scopes.includes(r)) {
            throw new NimbusScopeError(r);
        }
    }
}
/**
 * Assert that a sid-pinned token matches the session being attached. No-op
 * if the token isn't sid-pinned.
 *
 * @throws {NimbusSessionPinError} on mismatch.
 */
export function requireSessionPin(verified, attemptedSessionId) {
    if (verified.claims.sid !== undefined && verified.claims.sid !== attemptedSessionId) {
        throw new NimbusSessionPinError(verified.claims.sid, attemptedSessionId);
    }
}
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
export function setNimbusTokenCookie(token, expSec) {
    const nowSec = Math.floor(Date.now() / 1000);
    const maxAge = Math.max(0, expSec - nowSec);
    // Always Secure: browsers reject SameSite=None cookies without it,
    // and Secure cookies are accepted on http://localhost dev origins.
    return [
        `${NIMBUS_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
        'Path=/',
        `Max-Age=${maxAge}`,
        'SameSite=None',
        'HttpOnly',
        'Secure',
        'Partitioned',
    ].join('; ');
}
/**
 * Map a NimbusAuthError to a `Response` suitable for the embedder's
 * `fetch` handler to return. JSON body with `{ error, code }`.
 */
export function authErrorResponse(e) {
    if (e instanceof NimbusAuthError) {
        return new Response(JSON.stringify({ error: e.message, code: e.code }), {
            status: e.httpStatus,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
                // Hint to browsers that this is an auth challenge.
                ...(e.httpStatus === 401 ? { 'WWW-Authenticate': 'Bearer realm="nimbus"' } : {}),
            },
        });
    }
    // Unknown error — don't leak the message; log on caller side.
    return new Response(JSON.stringify({ error: 'Internal auth error', code: 'E_AUTH_UNKNOWN' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
