/**
 * session-router.ts — Rewrite `/s/<id>/<rest>` → DO-internal `/ <rest>`.
 *
 * Nimbus sessions live behind friendly URLs like `/s/nimble-otter-4271/`.
 * The Worker's fetch handler delegates to this module for anything that
 * starts with `/s/`. The DO itself remains blissfully ignorant of its
 * public URL: it sees `/ws`, `/api/*`, `/preview/*`, `/worker/*`,
 * `/port/<n>/*` — the same shape it did in the single-session era.
 *
 * Session identity flows two places:
 *   1. The DO ID — derived via `env.NIMBUS_SESSION.idFromName(sessionId)`.
 *      Deterministic, so the same URL always points at the same DO.
 *   2. The `X-Nimbus-Base` request header — set to the URL-prefix the DO
 *      is mounted at (e.g. `/s/nimble-otter-4271`). ViteDevServer uses
 *      this to emit correct `<base href>`, module URLs, `import.meta.env
 *      .BASE_URL`, and router `basename` so the user's React app resolves
 *      `<NavLink to="/docs">` → `/s/nimble-otter-4271/preview/docs`.
 *
 * Why a header instead of the DO auto-detecting?
 *   - The DO never sees the outer URL (we forward a rewritten Request).
 *   - Explicit plumbing is easier to test; auto-detect from Referer is
 *     unreliable (no Referer for API fetches from the xterm shell).
 *   - Single source of truth: this module owns the `/s/<id>/` mapping.
 */

import { isValidSessionId } from './session-id.js';

/** Prefix for all session-scoped routes. Centralized for future refactors. */
export const SESSION_ROUTE_PREFIX = '/s';

/** Header the Worker sets on forwarded requests. The DO reads it. */
export const BASE_PATH_HEADER = 'X-Nimbus-Base';

/**
 * Match `/s/<id>(/<rest>)?` with `<id>` being ANY lowercase-letters-digits-
 * dashes token. Shape validation happens in a second step so we can return
 * a specific 400 for malformed IDs (vs falling through to the Worker's 404).
 */
const SESSION_PATH_RE = /^\/s\/([^\/]+)(\/.*)?$/;

export interface ParsedSessionRoute {
  /** Session ID portion (unverified until `isValidSessionId` check). */
  sessionId: string;
  /** Inner path the DO should see, starting with "/" (e.g. "/ws", "/api/stats"). */
  innerPath: string;
  /** Public URL prefix the DO is mounted at (e.g. "/s/nimble-otter-4271"). */
  basePath: string;
}

/**
 * Attempt to parse a URL pathname as a session route.
 * Returns null if the pathname doesn't start with `/s/<something>`.
 *
 * Does NOT validate session ID shape — callers do that next so they can
 * emit a specific 400 (bad ID) vs continuing with a 404 fall-through.
 */
export function parseSessionRoute(pathname: string): ParsedSessionRoute | null {
  const m = pathname.match(SESSION_PATH_RE);
  if (!m) return null;
  const sessionId = m[1];
  // Ensure inner path starts with "/" and defaults to "/" for `/s/<id>`
  // (no trailing slash). This matches how the DO's existing handlers
  // distinguish `/preview` from `/preview/` — both reach the same code.
  const innerPath = m[2] && m[2].length > 0 ? m[2] : '/';
  return {
    sessionId,
    innerPath,
    basePath: `${SESSION_ROUTE_PREFIX}/${sessionId}`,
  };
}

/**
 * Forward a request to the session's DO.
 *
 * Contract:
 *   - Caller has already validated the session ID (or tolerates whatever
 *     DO spawns if they didn't — still safe, but malformed IDs should be
 *     rejected upstream with 400).
 *   - Original request's method, body, and headers are preserved.
 *   - `X-Nimbus-Base` is injected so the DO can thread it into ViteDevServer.
 *   - WebSocket upgrades flow naturally: `stub.fetch()` returns a Response
 *     with a `webSocket` field and status 101, which workerd passes through.
 */
export function forwardToSession(
  request: Request,
  route: ParsedSessionRoute,
  env: any,
): Promise<Response> {
  const url = new URL(request.url);
  // Rebuild the URL the DO will see: same origin, inner path, preserved query.
  const innerUrl = new URL(route.innerPath + url.search + url.hash, url.origin);

  // Clone headers and set X-Nimbus-Base. We can't mutate the original
  // Request's headers directly (they're immutable on a real Request).
  const headers = new Headers(request.headers);
  headers.set(BASE_PATH_HEADER, route.basePath);

  // Build the forwarded Request. Preserve body + method. For GETs/HEADs,
  // body is undefined (Request constructor rejects bodies there anyway).
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const inner = new Request(innerUrl.toString(), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    // Preserve WS upgrade. Workerd needs the Upgrade header to stay put;
    // copying via new Headers(...) does preserve it.
    redirect: 'manual',
  });

  const id = env.NIMBUS_SESSION.idFromName(route.sessionId);
  const stub = env.NIMBUS_SESSION.get(id);
  return stub.fetch(inner);
}

/** HTML body for the "invalid session ID" 400 page. Tiny, inline-only. */
export function renderInvalidSessionHtml(attemptedId: string): string {
  // Escape the attempted ID for display. We don't use innerHTML anywhere,
  // but defensive escaping keeps the HTML validator happy and avoids any
  // future XSS footguns if someone refactors this to document.write().
  const safe = String(attemptedId).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invalid session — Nimbus</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%}
  body{background:#0a0a0a;color:#e6edf3;font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",sans-serif;
       display:flex;align-items:center;justify-content:center;padding:24px;
       background-image:radial-gradient(700px 400px at 50% -10%,rgba(100,255,218,0.05),transparent 60%)}
  .card{max-width:520px;text-align:center}
  h1{font-size:28px;color:#64ffda;margin-bottom:12px;font-family:ui-monospace,Menlo,monospace}
  p{color:#8b949e;margin-bottom:24px}
  code{font-family:ui-monospace,Menlo,monospace;background:#111;padding:2px 8px;border-radius:4px;color:#e6edf3}
  a.btn{display:inline-block;background:#64ffda;color:#000;font-weight:700;padding:10px 22px;border-radius:6px;text-decoration:none}
  a.btn:hover{filter:brightness(1.1)}
</style></head>
<body><div class="card">
<h1>Invalid session</h1>
<p>The ID <code>${safe}</code> isn&rsquo;t a valid Nimbus session URL.<br>Launch a new one to get started.</p>
<a class="btn" href="/">&larr; Back to Nimbus</a>
</div></body></html>`;
}
