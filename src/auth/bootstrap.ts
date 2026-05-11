/**
 * auth/bootstrap.ts — same-origin sniff + admin-key check.
 *
 * Two non-Bearer authentication paths handled here:
 *
 *   1. Same-origin browser. Browsers automatically set:
 *        Sec-Fetch-Site: same-origin    (Chromium 76+, Firefox 90+, Safari 16.4+)
 *        Origin: <scheme>://<host>      (all modern browsers, all fetch+WS handshakes)
 *      Both headers are forbidden-headers per the Fetch spec — JS cannot
 *      set them, so an attacker page on attacker.example cannot forge
 *      a same-origin claim. We accept either signal as proof that the
 *      request originated from a tab loaded at the same Nimbus host.
 *
 *   2. Admin bootstrap. A single `ADMIN_KEY` env var (configured at
 *      deploy time via `wrangler secret put ADMIN_KEY`) acts as a
 *      master key for /auth/keys/* admin operations AND as a normal
 *      Bearer for /api/* gates. Constant-time compared to the
 *      header-provided plaintext to avoid timing leaks.
 */

import { constantTimeEqual, parseBearer } from './shared.js';

/** Does the request look like it came from a same-origin browser tab? */
export function isSameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  const expectedOrigin = `${url.protocol}//${url.host}`;

  // (a) Sec-Fetch-Site (preferred): browsers set this; JS cannot.
  const sfs = request.headers.get('Sec-Fetch-Site');
  if (sfs === 'same-origin') return true;
  // Sec-Fetch-Site = 'none' fires for top-level navigations; those don't
  // hit /api/* in practice, but be conservative and reject.

  // (b) Origin: <scheme>://<host>. Browsers set Origin on every fetch
  // POST and on WebSocket handshakes. Cross-origin pages cannot set
  // Origin to a value other than their own.
  const origin = request.headers.get('Origin');
  if (origin && origin === expectedOrigin) return true;

  return false;
}

/**
 * Check whether the request bears the ADMIN_KEY. Used for:
 *   - /auth/keys/* admin endpoints (the only path that REQUIRES admin).
 *   - /api/* fallback (admin key works as a master Bearer too).
 *
 * `env.ADMIN_KEY` is read from the Workers env. If unset/empty, no
 * bearer can ever match (we don't allow an empty-string match).
 *
 * Accepts the same two transports as extractBearer():
 *   - `Authorization: Bearer <key>`
 *   - `Sec-WebSocket-Protocol: nimbus.auth.bearer.<key>` (WS upgrade)
 */
export function isAdminKey(request: Request, env: any): boolean {
  const adminKey = env?.ADMIN_KEY;
  if (!adminKey || typeof adminKey !== 'string' || adminKey.length < 16) return false;
  const bearer = extractBearer(request);
  if (!bearer) return false;
  return constantTimeEqual(bearer, adminKey);
}

/**
 * Extract the bearer token (or null if missing/malformed). The middleware
 * uses this to feed `KeyRegistry.validate`.
 *
 * WebSocket handshakes don't allow `Authorization` headers from browser
 * JS, so we also accept `Sec-WebSocket-Protocol: nimbus.auth.bearer.<token>`
 * as an alternate transport. This is a documented opt-in by SDK clients;
 * the literal `nimbus.auth.bearer.` prefix marks the sub-protocol so it
 * never collides with real WebSocket sub-protocols.
 */
export function extractBearer(request: Request): string | null {
  const direct = parseBearer(request.headers.get('Authorization'));
  if (direct) return direct;
  // WS handshake fallback. Sec-WebSocket-Protocol can list multiple
  // comma-separated proposals; scan each.
  const sub = request.headers.get('Sec-WebSocket-Protocol');
  if (sub) {
    const parts = sub.split(',').map((s) => s.trim());
    for (const p of parts) {
      if (p.startsWith('nimbus.auth.bearer.')) return p.slice('nimbus.auth.bearer.'.length);
    }
  }
  return null;
}
