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
  NimbusTokenClaimsError,
  NimbusScopeError,
  NimbusSessionPinError,
  type VerifiedNimbusToken,
  type VerifiedNimbusRequestToken,
  type NimbusCredentialSource,
  isNimbusIdComponent,
} from './types.js';
import { utf8Length } from '@nimbus-sh/platform/utf8.js';

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

/**
 * The cookie name for one already-validated session id. Callers must pass a
 * sid this request's route already parsed and validated; the guard here only
 * keeps a malformed value from ever becoming a cookie name.
 */
export function nimbusTokenCookieName(sessionId: string): string {
  if (!isNimbusIdComponent(sessionId)) {
    throw new NimbusTokenMalformedError(`refusing to name an attach cookie from ${JSON.stringify(sessionId)}`);
  }
  return `${NIMBUS_TOKEN_COOKIE_PREFIX}${sessionId}`;
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
  return selectRequestCredential(request, sessionId)?.token ?? null;
}

function selectRequestCredential(request: Request, sessionId?: string): { token: string; source: NimbusCredentialSource } | null {
  // 1. Authorization header.
  const auth = request.headers.get('Authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return { token: m[1], source: 'authorization' };
  }
  // 2. Query parameter.
  const url = new URL(request.url);
  const q = url.searchParams.get(NIMBUS_TOKEN_QUERY);
  if (q && q.length > 0) return { token: q, source: 'query' };
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
        return { token: decodeURIComponent(pick), source: selected !== null ? 'session-cookie' : 'legacy-cookie' };
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
export function verifyRequestToken(request: Request, env: NimbusAuthEnv): Promise<VerifiedNimbusRequestToken>;
export function verifyRequestToken(request: Request, env: NimbusAuthEnv, opts: { requireToken: true; sessionId?: string }): Promise<VerifiedNimbusRequestToken>;
export function verifyRequestToken(
  request: Request,
  env: NimbusAuthEnv,
  opts: { requireToken?: boolean; sessionId?: string },
): Promise<VerifiedNimbusRequestToken | null>;
export async function verifyRequestToken(
  request: Request,
  env: NimbusAuthEnv,
  opts: { requireToken?: boolean; sessionId?: string } = {},
): Promise<VerifiedNimbusRequestToken | null> {
  const selected = selectRequestCredential(request, opts.sessionId);
  if (!selected) {
    if (opts.requireToken === false) return null;
    throw new NimbusTokenMalformedError(
      'no Bearer token in Authorization header, nimbus_token query, or cookie',
    );
  }
  const verified = await verifyNimbusToken(env, selected.token);
  if (selected.source === 'legacy-cookie' && verified.claims.sid === undefined) {
    throw new NimbusTokenClaimsError('legacy attach cookie must be session-pinned');
  }
  return { ...verified, credentialSource: selected.source };
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
): Promise<VerifiedNimbusRequestToken> {
  const verified = await verifyRequestToken(request, env, { requireToken: true, sessionId: required.sessionId });
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
 * Expire one session's route-owned attach cookie. Used when its session is
 * destroyed through the public path, so a dead session frees its jar slot.
 * Only the destroyed sid's name is ever expired here — sibling sessions'
 * credentials are untouched.
 */
export function expireSessionCookie(sessionId: string): string {
  return `${nimbusTokenCookieName(sessionId)}=; Path=/; Max-Age=0; SameSite=None; HttpOnly; Secure; Partitioned`;
}

/**
 * Migration headers for a request that authenticated via the legacy global
 * cookie: re-issue its verified token under the route-owned name and expire
 * the legacy name, in the same response. Returns [] unless verification used
 * the legacy name — headers, queries and route-owned cookies never
 * cause this migration, even if a legacy name is present. The re-issued
 * token keeps its verified expiry; this never mints, never extends, never
 * consults anything but the already-verified claims.
 */
/**
 * Plan the legacy-migration headers for an authenticated session request.
 * Runs at authentication, before any session dispatch: the capacity check
 * throws here, so a refusal precedes every side effect and the response
 * policy below only applies already-validated headers, never failing after
 * a write has committed. Returns [] when no migration applies.
 */
export function planSessionCookieMigration(
  requestCookie: string | null,
  verified: VerifiedNimbusRequestToken,
  sessionId: string,
): readonly string[] {
  if (!requestCookie) return [];
  if (verified.credentialSource !== 'legacy-cookie') return [];
  if (verified.claims.sid !== sessionId || verified.claims.exp === undefined) return [];
  const cookie = setNimbusTokenCookie(verified.raw, verified.claims.exp, sessionId);
  enforceSessionCookieCapacity(requestCookie, cookie, true);
  return [
    expireLegacyNimbusTokenCookie(),
    cookie,
  ];
}

/**
 * The response half of {@link planSessionCookieMigration}: headers already
 * validated at authentication. Kept as a thin alias so response sites name
 * the policy, not the plan step.
 */
export function sessionCookieMigration(
  requestCookie: string | null,
  verified: VerifiedNimbusRequestToken,
  sessionId: string,
): readonly string[] {
  return planSessionCookieMigration(requestCookie, verified, sessionId);
}

/**
 * Largest attach-cookie jar an exchange will grow: at most this many
 * per-session names, a separate request-header budget, and Chrome's CHIPS
 * name/value storage quota. The proposed cookie is measured, never estimated
 * from a fixed-size placeholder. Sessions
 * accumulate (one name each, never evicted), so issuance stops before the
 * jar would push a browser past its per-request header ceiling; the
 * caller retries from a fresh profile or prunes dead sessions first.
 */
export const NIMBUS_TOKEN_COOKIE_LIMIT = 24;
export const NIMBUS_TOKEN_COOKIE_HEADER_LIMIT = 16 * 1024;
export const NIMBUS_TOKEN_SET_COOKIE_LIMIT = 4096;
/** Chrome's name/value quota per CHIPS partition and registrable domain. */
export const NIMBUS_TOKEN_PARTITION_BYTES_LIMIT = 10_240;

/**
 * Refuse an exchange that would overflow the browser's cookie jar.
 * Runs before any single-use bootstrap is consumed, so a refusal never
 * burns a one-shot credential. Eviction is never an option: dropping a
 * sibling session's credential to make room would be the same ownership
 * bug in reverse.
 */
export function enforceSessionCookieCapacity(cookieHeader: string | null, proposedCookie: string, expireLegacy = false): void {
  const cookie = cookieHeader ?? '';
  let names = 0;
  let partitionBytes = 0;
  let headerBytes = 0;
  const proposedPair = proposedCookie.split(';', 1)[0];
  const proposedName = proposedPair.slice(0, proposedPair.indexOf('='));
  for (const c of cookie.split(';')) {
    const pair = c.trim();
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at);
    // A replacement does not grow the jar: the proposed name is excluded
    // below and re-added once, so re-attaching a held session always fits.
    if (name.startsWith(NIMBUS_TOKEN_COOKIE_PREFIX) && name !== proposedName) names += 1;
    // Cookie does not reveal partitioning, so count every visible pair
    // conservatively. Chrome counts name + value, excluding attributes.
    if (name === proposedName || (expireLegacy && name === NIMBUS_TOKEN_COOKIE)) continue;
    partitionBytes += utf8Length(name) + utf8Length(pair.slice(at + 1));
    headerBytes += utf8Length(pair) + 2;
  }
  partitionBytes += utf8Length(proposedPair) - 1;
  headerBytes += utf8Length(proposedPair);
  if (names >= NIMBUS_TOKEN_COOKIE_LIMIT || partitionBytes > NIMBUS_TOKEN_PARTITION_BYTES_LIMIT
    || headerBytes > NIMBUS_TOKEN_COOKIE_HEADER_LIMIT) {
    throw new NimbusTokenMalformedError('too many session attach credentials for one browser jar');
  }
  if (utf8Length(proposedCookie) > NIMBUS_TOKEN_SET_COOKIE_LIMIT) {
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
