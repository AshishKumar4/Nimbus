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

import { verifyNimbusToken, type NimbusAuthEnv } from './token.js';
import {
  NimbusAuthError,
  NimbusTokenMalformedError,
  NimbusScopeError,
  NimbusSessionPinError,
  type VerifiedNimbusToken,
} from './types.js';

/** Cookie name used for in-iframe token persistence. */
export const NIMBUS_TOKEN_COOKIE = 'nimbus_token';

/** Query parameter name. */
export const NIMBUS_TOKEN_QUERY = 'nimbus_token';

/**
 * Pull a token from a Request. Returns null if absent (caller decides
 * whether absence is an auth failure or just "anonymous").
 *
 * Precedence: Authorization header → query → cookie.
 */
export function extractBearerToken(request: Request): string | null {
  // 1. Authorization header.
  const auth = request.headers.get('Authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1];
  }
  // 2. Query parameter.
  const url = new URL(request.url);
  const q = url.searchParams.get(NIMBUS_TOKEN_QUERY);
  if (q && q.length > 0) return q;
  // 3. Cookie.
  const cookie = request.headers.get('Cookie');
  if (cookie) {
    for (const c of cookie.split(';')) {
      const [k, v] = c.trim().split('=', 2);
      if (k === NIMBUS_TOKEN_COOKIE && v) return decodeURIComponent(v);
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
export async function verifyRequestToken(
  request: Request,
  env: NimbusAuthEnv,
  opts: { requireToken?: boolean } = {},
): Promise<VerifiedNimbusToken | null> {
  const token = extractBearerToken(request);
  if (!token) {
    if (opts.requireToken === false) return null;
    throw new NimbusTokenMalformedError(
      'no Bearer token in Authorization header, nimbus_token query, or cookie',
    );
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
export function requireScopes(
  verified: VerifiedNimbusToken,
  required: readonly string[],
): void {
  if (verified.claims.scopes === undefined) return;
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
export function requireSessionPin(
  verified: VerifiedNimbusToken,
  attemptedSessionId: string,
): void {
  if (verified.claims.sid !== undefined && verified.claims.sid !== attemptedSessionId) {
    throw new NimbusSessionPinError(verified.claims.sid, attemptedSessionId);
  }
}

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
export function setNimbusTokenCookie(token: string, expSec: number, opts: { secure?: boolean } = {}): string {
  const secure = opts.secure !== false; // default true
  const nowSec = Math.floor(Date.now() / 1000);
  const maxAge = Math.max(0, expSec - nowSec);
  const parts = [
    `${NIMBUS_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/s',
    `Max-Age=${maxAge}`,
    'SameSite=None',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Map a NimbusAuthError to a `Response` suitable for the embedder's
 * `fetch` handler to return. JSON body with `{ error, code }`.
 */
export function authErrorResponse(e: unknown): Response {
  if (e instanceof NimbusAuthError) {
    return new Response(
      JSON.stringify({ error: e.message, code: e.code }),
      {
        status: e.httpStatus,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          // Hint to browsers that this is an auth challenge.
          ...(e.httpStatus === 401 ? { 'WWW-Authenticate': 'Bearer realm="nimbus"' } : {}),
        },
      },
    );
  }
  // Unknown error — don't leak the message; log on caller side.
  return new Response(
    JSON.stringify({ error: 'Internal auth error', code: 'E_AUTH_UNKNOWN' }),
    { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}
