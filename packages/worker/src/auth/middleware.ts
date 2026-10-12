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

import { verifyNimbusToken, type NimbusAuthEnv } from './token.js';
import {
  NimbusAuthError,
  NimbusTokenMalformedError,
  NimbusScopeError,
  NimbusSessionPinError,
  type VerifiedNimbusToken,
} from './types.js';

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
export const NIMBUS_TOKEN_COOKIE = '__Host-nimbus_token';

/** Prefix of every per-session attach cookie name (`${PREFIX}<sid>`). */
export const NIMBUS_TOKEN_COOKIE_PREFIX = '__Host-nimbus_token-';

/** Largest sid accepted into a cookie name (matches {@link ID_COMPONENT_RE}). */
export const NIMBUS_TOKEN_COOKIE_SID_MAX = 128;

/**
 * The cookie name for one already-validated session id. Callers must pass a
 * sid this request's route already parsed and validated; the guard here only
 * keeps a malformed value from ever becoming a cookie name.
 */
export function nimbusTokenCookieName(sessionId: string): string {
  if (!isValidNimbusTokenCookieSid(sessionId)) {
    throw new NimbusTokenMalformedError(`refusing to name an attach cookie from ${JSON.stringify(sessionId)}`);
  }
  return `${NIMBUS_TOKEN_COOKIE_PREFIX}${sessionId}`;
}

/** Whether a value may appear in an attach cookie name: same alphabet as a route sid. */
export function isValidNimbusTokenCookieSid(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= NIMBUS_TOKEN_COOKIE_SID_MAX
    && /^[A-Za-z0-9._-]+$/.test(value);
}

/** Query parameter name. */
export const NIMBUS_TOKEN_QUERY = 'nimbus_token';

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
export function extractBearerToken(request: Request, sessionId?: string): string | null {
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
  // 3. Cookie: the route's own per-session name, then the pre-per-session
  // legacy name. The legacy cookie authenticates only its pinned session:
  // `authorizeRequest` still requires the pin to equal the route sid, so a
  // legacy credential for another session fails exactly as before. Per-sid
  // wins when both are present.
  const cookie = request.headers.get('Cookie');
  if (cookie && sessionId !== undefined) {
    let selected: string | null = null;
    let legacy: string | null = null;
    const wanted = nimbusTokenCookieName(sessionId);
    for (const c of cookie.split(';')) {
      const pair = c.trim();
      const at = pair.indexOf('=');
      if (at <= 0) continue;
      const k = pair.slice(0, at);
      if (k === wanted && selected === null) selected = pair.slice(at + 1);
      else if (k === NIMBUS_TOKEN_COOKIE && legacy === null) legacy = pair.slice(at + 1);
    }
    const pick = selected ?? legacy;
    if (pick) {
      try {
        return decodeURIComponent(pick);
      } catch {
        return null;
      }
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
export function verifyRequestToken(request: Request, env: NimbusAuthEnv, opts?: { requireToken?: boolean; sessionId?: string }): Promise<VerifiedNimbusToken | null>;
export function verifyRequestToken(
  request: Request,
  env: NimbusAuthEnv,
  opts: { requireToken?: boolean; sessionId?: string },
): Promise<VerifiedNimbusToken | null>;
export async function verifyRequestToken(
  request: Request,
  env: NimbusAuthEnv,
  opts: { requireToken?: boolean; sessionId?: string } = {},
): Promise<VerifiedNimbusToken | null> {
  const token = extractBearerToken(request, opts.sessionId);
  if (!token) {
    if (opts.requireToken === false) return null;
    throw new NimbusTokenMalformedError(
      'no Bearer token in Authorization header, nimbus_token query, or cookie',
    );
  }
  return verifyNimbusToken(env, token);
}

/**
 * Authorize a request for a route: verify its token, require every scope in
 * `scopes`, and, on a route that addresses a session, require the token's
 * pin to match it. Throws the NimbusAuthError of the first check that fails;
 * each route keeps its own legacy policy and error envelope.
 */
export async function authorizeRequest(
  request: Request,
  env: NimbusAuthEnv,
  required: { scopes: readonly string[]; sessionId?: string },
): Promise<VerifiedNimbusToken> {
  const verified = await verifyRequestToken(request, env, { sessionId: required.sessionId });
  requireScopes(verified, required.scopes);
  if (required.sessionId !== undefined) requireSessionPin(verified, required.sessionId);
  return verified;
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
export function setNimbusTokenCookie(token: string, expSec: number, sessionId: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const maxAge = Math.max(0, expSec - nowSec);
  // Always Secure: browsers reject SameSite=None cookies without it,
  // and Secure cookies are accepted on http://localhost dev origins.
  return [
    `${nimbusTokenCookieName(sessionId)}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'SameSite=None',
    'HttpOnly',
    'Secure',
    'Partitioned',
  ].join('; ');
}

/**
 * Expire the pre-per-session legacy cookie after a migration: once a route
 * authenticates its own credential, the ambiguous global name must not linger
 * to be selected again.
 */
export function expireLegacyNimbusTokenCookie(): string {
  return `${NIMBUS_TOKEN_COOKIE}=; Path=/; Max-Age=0; SameSite=None; HttpOnly; Secure; Partitioned`;
}

/**
 * Migration headers for a request that authenticated via the legacy global
 * cookie: re-issue its verified token under the route-owned name and expire
 * the legacy name, in the same response. Returns [] unless the jar holds the
 * legacy name but NOT the route-owned one — a jar that already migrated, or
 * that never had the legacy credential, gets no extra bytes. The re-issued
 * token keeps its verified expiry; this never mints, never extends, never
 * consults anything but the already-verified claims.
 */
export function sessionCookieMigration(
  requestCookie: string | null,
  verified: VerifiedNimbusToken,
  sessionId: string,
): string[] {
  if (!requestCookie) return [];
  let hasRoute = false;
  let hasLegacy = false;
  const wanted = `${NIMBUS_TOKEN_COOKIE_PREFIX}${sessionId}=`;
  for (const c of requestCookie.split(';')) {
    const pair = c.trim();
    if (pair.startsWith(wanted)) hasRoute = true;
    else if (pair === NIMBUS_TOKEN_COOKIE || pair.startsWith(`${NIMBUS_TOKEN_COOKIE}=`)) hasLegacy = true;
    if (hasRoute && hasLegacy) break;
  }
  if (!hasLegacy || hasRoute) return [];
  if (verified.claims.sid !== sessionId || verified.claims.exp === undefined) return [];
  return [
    setNimbusTokenCookie(verified.raw, verified.claims.exp, sessionId),
    expireLegacyNimbusTokenCookie(),
  ];
}

/**
 * Largest attach-cookie jar an exchange will grow: at most this many
 * per-session names, and the request's Cookie header plus the new
 * `Set-Cookie` bytes stay under this many bytes in total. Sessions
 * accumulate (one name each, never evicted), so issuance stops before the
 * jar would push a browser past its per-request header ceiling; the
 * caller retries from a fresh profile or prunes dead sessions first.
 */
export const NIMBUS_TOKEN_COOKIE_LIMIT = 24;
export const NIMBUS_TOKEN_COOKIE_HEADER_LIMIT = 16 * 1024;
export const NIMBUS_TOKEN_SET_COOKIE_LIMIT = 4096;

/**
 * Refuse an exchange that would overflow the browser's cookie jar.
 * Runs before any single-use bootstrap is consumed, so a refusal never
 * burns a one-shot credential. Eviction is never an option: dropping a
 * sibling session's credential to make room would be the same ownership
 * bug in reverse.
 */
export function enforceSessionCookieCapacity(request: Request, sessionId: string): void {
  const cookie = request.headers.get('Cookie') ?? '';
  let names = 0;
  let sessionBytes = 0;
  for (const c of cookie.split(';')) {
    const pair = c.trim();
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    if (pair.startsWith(NIMBUS_TOKEN_COOKIE_PREFIX)) {
      names += 1;
      sessionBytes += pair.length + 2;
    } else if (pair === NIMBUS_TOKEN_COOKIE || pair.startsWith(`${NIMBUS_TOKEN_COOKIE}=`)) {
      sessionBytes += pair.length + 2;
    }
  }
  const fresh = `${NIMBUS_TOKEN_COOKIE_PREFIX}${sessionId}=`.length + 1024;
  if (names >= NIMBUS_TOKEN_COOKIE_LIMIT || sessionBytes + fresh > NIMBUS_TOKEN_COOKIE_HEADER_LIMIT) {
    throw new NimbusTokenMalformedError('too many session attach credentials for one browser jar');
  }
  const setCookie = `${NIMBUS_TOKEN_COOKIE_PREFIX}${sessionId}=${'x'.repeat(1024)}; Path=/; Max-Age=0; SameSite=None; HttpOnly; Secure; Partitioned`;
  if (new TextEncoder().encode(setCookie).length > NIMBUS_TOKEN_SET_COOKIE_LIMIT) {
    throw new NimbusTokenMalformedError('a session attach credential does not fit one Set-Cookie');
  }
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
