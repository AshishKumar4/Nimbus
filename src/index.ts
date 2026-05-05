import {
  NimbusSession,
  NimbusAssetsRPC,
  NimbusLoaderRPC,
  NimbusLoadedWorker,
  NimbusLoadedEntrypoint,
  NimbusDurableObjectNamespace,
  NimbusDOStub,
} from './nimbus-session.js';
import { SupervisorRPC } from './supervisor-rpc.js';
import { CirrusHmrRPC } from './real-vite-hmr.js';
import { generateSessionId, isValidSessionId } from './session-id.js';
import {
  parseSessionRoute,
  forwardToSession,
  renderInvalidSessionHtml,
  SESSION_ROUTE_PREFIX,
} from './session-router.js';
import { setCtxExports, getCtxExports as _getCtxExports } from './ctx-exports.js';

// Re-export inner-Worker binding shims so wrangler bundles them AND
// ctx.exports auto-populates Service Bindings for them (via
// enable_ctx_exports; default at compat date 2026-04-01+). The
// nimbus-wrangler inner-env synthesis uses:
//   ctx.exports.NimbusAssetsRPC(...)                →  env.ASSETS
//   ctx.exports.NimbusLoaderRPC(...)                →  env.LOADER
//   ctx.exports.NimbusLoadedWorker(...)             →  return of LOADER.load/get
//   ctx.exports.NimbusLoadedEntrypoint(...)         →  return of worker.getEntrypoint()
//   ctx.exports.NimbusDurableObjectNamespace(...)   →  env.MY_DO (per binding)
//   ctx.exports.NimbusDOStub(...)                   →  return of MY_DO.get(id)
export {
  NimbusSession,
  SupervisorRPC,
  NimbusAssetsRPC,
  NimbusLoaderRPC,
  NimbusLoadedWorker,
  NimbusLoadedEntrypoint,
  NimbusDurableObjectNamespace,
  NimbusDOStub,
  // Phase 2 real-vite HMR RPC (facet ↔ supervisor event pump).
  CirrusHmrRPC,
};

/**
 * Module-level reference to ctx.exports from the fetch handler.
 * Used by NimbusSession to create loopback bindings for facets.
 * Set once on the first fetch() call.
 *
 * Storage lives in `./ctx-exports.ts` (a leaf module) so helpers like the
 * NimbusFacetPool can read it without importing the full DO class graph.
 */
export function getCtxExports(): any {
  return _getCtxExports();
}

/**
 * Legacy root-path DO routes. Before multi-session landed, everything
 * hit a single `idFromName('default-session')` DO at root paths.
 * Old bookmarks to these URLs get a friendly redirect to the landing
 * page rather than a silent 404.
 */
const LEGACY_ROOT_PATHS = ['/ws', '/api/', '/preview', '/worker', '/port/'];

function isLegacyRootPath(pathname: string): boolean {
  for (const p of LEGACY_ROOT_PATHS) {
    if (p.endsWith('/')) {
      if (pathname.startsWith(p)) return true;
    } else {
      if (pathname === p || pathname.startsWith(p + '/')) return true;
    }
  }
  return false;
}

export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    // Capture ctx.exports on first call (provides loopback bindings)
    if (ctx?.exports) setCtxExports(ctx.exports);

    const url = new URL(request.url);

    // ── /new — spawn a fresh session and redirect ──────────────────────
    // POST is the canonical path (HTML form submission). GET is accepted
    // too so `curl -L` works ergonomically from the CLI.
    if (url.pathname === '/new') {
      if (request.method !== 'POST' && request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 });
      }
      const sessionId = generateSessionId();
      const target = `${SESSION_ROUTE_PREFIX}/${sessionId}/`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: target,
          // No cache: each /new call should mint a fresh ID.
          'Cache-Control': 'no-store',
        },
      });
    }

    // ── /s/<id>/... — session-scoped routes forward to a DO ────────────
    const route = parseSessionRoute(url.pathname);
    if (route) {
      if (!isValidSessionId(route.sessionId)) {
        return new Response(renderInvalidSessionHtml(route.sessionId), {
          status: 400,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        });
      }
      // `/s/<id>` and `/s/<id>/` (no inner path) → serve the xterm UI shell
      // from public/s/index.html via the ASSETS binding. The HTML then
      // opens its own WebSocket against /s/<id>/ws which flows through the
      // DO forwarder below.
      if (route.innerPath === '/' || route.innerPath === '') {
        if (env.ASSETS) {
          const shellUrl = new URL('/s/index.html', url.origin);
          return env.ASSETS.fetch(new Request(shellUrl.toString(), {
            method: 'GET',
            headers: request.headers,
          }));
        }
        // No ASSETS binding (older config) — send a minimal fallback pointing
        // people back to the landing page so the deploy doesn't hard-break.
        return new Response(
          '<!DOCTYPE html><meta http-equiv="refresh" content="0; url=/"><title>Nimbus</title>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }
      return forwardToSession(request, route, env);
    }

    // ── Back-compat: old root DO paths 302 to the landing page ─────────
    // Before multi-session, `/ws`, `/api/*`, `/preview/*` etc. hit a
    // shared DO. Now they're dead ends. Anyone with a stale bookmark
    // lands on the Nimbus landing page where they can launch a new one.
    if (isLegacyRootPath(url.pathname)) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/', 'Cache-Control': 'no-store' },
      });
    }

    // Everything else — Worker returns 404. The asset binding (for `/`
    // and `/s/*` static files) runs BEFORE this handler, so we only
    // hit this line for paths with no matching asset and no route.
    return new Response('Not found', { status: 404 });
  },
};
