/**
 * auth/middleware.ts — Worker-entry middleware that gates protected
 * paths before they reach the session DO.
 *
 * Public contract:
 *   `applyAuthMiddleware(request, env)` returns:
 *     - `null` — request is allowed; the caller should proceed with
 *               normal routing.
 *     - `Response` — request is denied; the caller should return this
 *               Response immediately.
 *
 * The middleware NEVER mutates the request. Callers continue with the
 * same Request object after a `null` return.
 *
 * Path policy:
 *   - `/auth/keys/*`       admin endpoints (require admin key)
 *   - `/api/*`             gated (Bearer OR same-origin browser)
 *   - `/s/<sid>/api/*`     gated (Bearer OR same-origin browser)
 *   - `/s/<sid>/ws`        gated (Bearer OR same-origin browser; WS
 *                          fallback via Sec-WebSocket-Protocol)
 *   - everything else      passthrough (landing page, asset paths,
 *                          /new, /preview, /worker, /port, /s/<sid>/
 *                          HTML shell)
 *
 * The gate is intentionally permissive for paths that serve user-loaded
 * pages — those inherit auth via the tab they were loaded from. The
 * /api/* surface is the only place an attacker could mutate state
 * without rendering a Nimbus page first.
 */

import { extractBearer, isAdminKey, isSameOrigin } from './bootstrap.js';
import { AUTH_DO_NAME } from './shared-constants.js';

/** Reserved DO name for the singleton auth DO. */
export const AUTH_DO_RESERVED_ID = AUTH_DO_NAME;

/**
 * Internal path the auth DO uses to validate a token. Worker-only —
 * never exposed publicly; the Worker entry intercepts /__auth__/*.
 */
const AUTH_DO_VALIDATE_PATH = '/__auth__/validate';

/** Path prefixes we GATE. (Everything else is passthrough.) */
function isGatedPath(pathname: string): boolean {
  // /auth/keys/* admin
  if (pathname.startsWith('/auth/keys/')) return true;
  // /api/* (root, never used today but defensive)
  if (pathname.startsWith('/api/')) return true;
  // /s/<sid>/api/* and /s/<sid>/ws
  const sMatch = pathname.match(/^\/s\/[^/]+(\/.*)?$/);
  if (sMatch) {
    const inner = sMatch[1] || '';
    if (inner.startsWith('/api/')) return true;
    if (inner === '/ws') return true;
  }
  return false;
}

/** Admin-only paths (require admin key, not regular Bearer). */
function isAdminPath(pathname: string): boolean {
  return pathname.startsWith('/auth/keys/');
}

/** Reserved-DO guard. Reject /s/__nimbus_auth__/* — see audit. */
function isReservedAuthDOPath(pathname: string): boolean {
  return pathname === `/s/${AUTH_DO_RESERVED_ID}`
      || pathname.startsWith(`/s/${AUTH_DO_RESERVED_ID}/`);
}

/** JSON 4xx response helper. */
function deny(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  const body = { error, ...extra };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer realm="nimbus"',
  };
  if (typeof extra.retryAfter === 'number') {
    headers['Retry-After'] = String(extra.retryAfter);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Apply the auth middleware. Returns null to allow, or a Response to deny.
 */
export async function applyAuthMiddleware(
  request: Request,
  env: any,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Reserved DO guard: never let any request reach /s/__nimbus_auth__/*.
  if (isReservedAuthDOPath(path)) {
    return deny(403, 'reserved');
  }

  // Passthrough for paths we don't gate.
  if (!isGatedPath(path)) return null;

  // CORS preflights pass through. The Worker entry / DO has its own
  // preflight handler; we don't want to 401 OPTIONS or we'd break
  // CORS preflights entirely.
  if (request.method === 'OPTIONS') return null;

  // Admin-only path?
  if (isAdminPath(path)) {
    if (isAdminKey(request, env)) return null;
    return deny(401, 'admin key required');
  }

  // Regular /api/* gate. Three acceptance paths:
  //   1. Admin key (acts as master Bearer)
  //   2. Same-origin browser
  //   3. Valid Bearer token (validated via auth DO)
  if (isAdminKey(request, env)) return null;
  if (isSameOrigin(request)) return null;

  const bearer = extractBearer(request);
  if (!bearer) return deny(401, 'authentication required');

  // Dispatch to the auth DO for token validation.
  const decision = await validateViaAuthDO(bearer, env);
  if (decision.kind === 'ok') return null;
  if (decision.kind === 'rate-limited') {
    return deny(429, 'rate limit exceeded', { retryAfter: Math.ceil(decision.retryAfterMs / 1000) });
  }
  if (decision.kind === 'revoked') {
    return deny(401, 'key revoked');
  }
  return deny(401, 'invalid bearer token');
}

/** Validation response shape returned by the auth DO. */
type DOValidateResponse =
  | { kind: 'ok'; keyId: string }
  | { kind: 'rate-limited'; keyId: string; retryAfterMs: number }
  | { kind: 'invalid' }
  | { kind: 'revoked'; keyId: string };

/**
 * Send a {token} POST to the auth DO. Auth DO is reached via the same
 * NIMBUS_SESSION binding (singleton DO at the reserved well-known ID).
 */
async function validateViaAuthDO(token: string, env: any): Promise<DOValidateResponse> {
  if (!env?.NIMBUS_SESSION) {
    return { kind: 'invalid' };
  }
  const id = env.NIMBUS_SESSION.idFromName(AUTH_DO_RESERVED_ID);
  const stub = env.NIMBUS_SESSION.get(id);
  // Use a synthetic origin to keep DO-side URL parsing predictable.
  const req = new Request(`https://auth.invalid${AUTH_DO_VALIDATE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const resp = await stub.fetch(req);
  if (!resp.ok) {
    // Defensive: any non-ok DO response is treated as invalid (not as
    // an internal-server-error 500 reflection). The auth path shouldn't
    // be a way for clients to gain information about DO health.
    return { kind: 'invalid' };
  }
  try {
    return await resp.json() as DOValidateResponse;
  } catch {
    return { kind: 'invalid' };
  }
}
