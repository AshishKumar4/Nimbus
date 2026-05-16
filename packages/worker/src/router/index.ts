/**
 * router/index.ts — `createNimbusHandler` factory.
 *
 * The Worker entry's `default { fetch }` is now a thin call into this
 * factory. The factory is the **composable surface** an embedder gets via
 * `@nimbus-sh/worker`:
 *
 *   import { NimbusSession, createNimbusHandler } from '@nimbus-sh/worker';
 *   export { NimbusSession };
 *   export default createNimbusHandler({
 *     // Optional embedder hooks (all default no-op):
 *     hooks: {
 *       onSessionStart: async (ctx) => { … },
 *       onSessionEnd:   async (ctx) => { … },
 *     },
 *     // Optional embedder routes that run BEFORE the Nimbus router.
 *     // Return null to fall through to Nimbus's handling.
 *     routes: async (req, env, ctx) => {
 *       if (new URL(req.url).pathname === '/healthz') return new Response('ok');
 *       return null;
 *     },
 *     // Optional auth-mode override (default 'auto').
 *     auth: { mode: 'auto', legacyPublic: false },
 *   });
 *
 * Why a factory + hooks (not a class)?
 *   - Closures match the Workers programming model. A factory returns a
 *     fresh module-export-shaped object that the Workers runtime calls.
 *   - Hooks let embedders observe lifecycle without forking the DO. They
 *     run alongside, never block (errors are caught + logged).
 *   - The default `createNimbusHandler()` (zero args) is the
 *     "ship-Nimbus-as-is" case — exactly what `apps/dogfood/` does.
 */

import {
  generateSessionId,
  isValidSessionId,
} from '../_shared/session-id.js';
import {
  parseSessionRoute,
  forwardToSession,
  renderInvalidSessionHtml,
  SESSION_ROUTE_PREFIX,
  LEGACY_PUBLIC_DO_SEGMENT,
} from '../_shared/session-router.js';
import {
  verifyRequestToken,
  authErrorResponse,
  NimbusAuthError,
  NimbusTokenMalformedError,
  type NimbusAuthEnv,
} from '../auth/index.js';
import { setCtxExports } from '../session/ctx-exports.js';

/**
 * Lifecycle event a hook receives. Hooks should treat this as read-only.
 */
export interface NimbusHookContext {
  /** Tenant segment used for the DO instance name. */
  tenantSegment: string;
  /** Session ID portion of the URL. */
  sessionId: string;
  /** The inbound Request (read-only — clone via `request.clone()` to read body). */
  request: Request;
  /** Bindings env. */
  env: any;
}

/**
 * Embedder hooks. Every hook is optional and defaults to no-op. Errors
 * thrown from a hook are caught and logged via `console.warn`; they do
 * NOT short-circuit the request.
 *
 * `onSessionStart` fires on the first WebSocket upgrade for a session
 * (not on every HTTP API call). `onSessionEnd` fires when the DO emits a
 * session-end event (not implemented v1; reserved).
 */
export interface NimbusHooks {
  /**
   * Called when a new session is first attached via WebSocket. Useful
   * for embedder-side audit logging, metrics, or token-binding
   * provenance recording.
   *
   * @param ctx Lifecycle context.
   */
  onSessionStart?(ctx: NimbusHookContext): void | Promise<void>;

  /**
   * Reserved for v0.2. Will fire when a session is destroyed (TTL
   * elapsed, explicit destroy, or DO eviction).
   */
  onSessionEnd?(ctx: NimbusHookContext): void | Promise<void>;
}

/**
 * Auth-mode selector for {@link createNimbusHandler}.
 *
 * `'auto'` (default):
 *   - If `env.JWT_SECRET` is set AND `env.NIMBUS_LEGACY_PUBLIC !== '1'`:
 *     verify every `/s/<id>/` request against the JWT.
 *   - Otherwise: legacy-public mode — all `/s/<id>/` requests route to
 *     the `legacy:public:_` tenant segment (single shared tenant).
 *
 * `'enforce'`: always require a valid token; fail closed if `JWT_SECRET`
 * is missing.
 *
 * `'legacy'`: always legacy-public; never verify. Use only for the
 * live demo / single-tenant deployments where the URL is the auth.
 */
export type AuthMode = 'auto' | 'enforce' | 'legacy';

/** Configuration for the auth surface. */
export interface NimbusAuthConfig {
  mode?: AuthMode;
  /**
   * Backward-compat opt-in for the legacy single-tenant fallback. Same
   * effect as `mode: 'legacy'`; provided as a named flag for clarity
   * in embedder configs. Ignored when `mode` is set explicitly.
   */
  legacyPublic?: boolean;
}

/**
 * Custom-routes hook. Runs BEFORE the Nimbus router. Return a `Response`
 * to short-circuit Nimbus; return `null` to fall through.
 *
 * Embedders use this to mount `/api/auth/nimbus-token` (token mint),
 * `/healthz`, `/metrics`, etc. without proxying through the DO.
 */
export type CustomRoutes = (
  request: Request,
  env: any,
  ctx: ExecutionContext,
) => Response | null | Promise<Response | null>;

/** Options for {@link createNimbusHandler}. */
export interface CreateNimbusHandlerOptions {
  /** Embedder hooks. All optional. */
  hooks?: NimbusHooks;
  /** Custom routes that run before Nimbus's router. */
  routes?: CustomRoutes;
  /** Auth-mode selector. Default `'auto'`. */
  auth?: NimbusAuthConfig;
}

/**
 * The shape every `default export` Workers handler must satisfy.
 * Exported so embedders can type their own composed default export.
 */
export interface NimbusHandler {
  fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response>;
}

/**
 * Build a Nimbus default-export handler. The returned object is exactly
 * what `export default` expects in a Workers entry module.
 *
 * @example minimal embedder
 * ```ts
 * import { NimbusSession, createNimbusHandler } from '@nimbus-sh/worker';
 * export { NimbusSession };
 * export default createNimbusHandler();
 * ```
 *
 * @example embedder with auth + a custom route
 * ```ts
 * import { NimbusSession, createNimbusHandler } from '@nimbus-sh/worker';
 * import { issueNimbusToken } from '@nimbus-sh/sdk/token';
 *
 * export { NimbusSession };
 * export default createNimbusHandler({
 *   auth: { mode: 'enforce' },
 *   routes: async (req, env) => {
 *     if (new URL(req.url).pathname === '/api/auth/mint' && req.method === 'POST') {
 *       const { tenant, sub } = await req.json();
 *       const token = await issueNimbusToken(env, { tn: tenant, sub });
 *       return Response.json({ token });
 *     }
 *     return null;
 *   },
 *   hooks: {
 *     onSessionStart: ({ tenantSegment, sessionId }) =>
 *       console.log(`session ${sessionId} for ${tenantSegment}`),
 *   },
 * });
 * ```
 */
export function createNimbusHandler(
  options: CreateNimbusHandlerOptions = {},
): NimbusHandler {
  const hooks = options.hooks ?? {};
  const customRoutes = options.routes;
  const authConfig = options.auth ?? {};
  // Resolve auth mode at factory-construction time.
  const explicitMode = authConfig.mode
    ?? (authConfig.legacyPublic ? 'legacy' : undefined);

  return {
    async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
      // Capture ctx.exports on first call (loopback bindings for facets).
      if ((ctx as any)?.exports) setCtxExports((ctx as any).exports);

      // Embedder custom routes run first.
      if (customRoutes) {
        try {
          const r = await customRoutes(request, env, ctx);
          if (r) return r;
        } catch (e: any) {
          console.error('[nimbus] custom route threw:', e?.stack || e);
          return new Response('Internal error in embedder route', { status: 500 });
        }
      }

      const url = new URL(request.url);

      // ── /new — spawn a fresh session and redirect ───────────────────
      if (url.pathname === '/new') {
        if (request.method !== 'POST' && request.method !== 'GET') {
          return new Response('Method not allowed', { status: 405 });
        }
        const sessionId = generateSessionId();
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${SESSION_ROUTE_PREFIX}/${sessionId}/`,
            'Cache-Control': 'no-store',
          },
        });
      }

      // ── /s/<id>/... — session-scoped routes ─────────────────────────
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

        // Resolve tenant segment per auth mode.
        const tenantSegment = await resolveTenantSegment(
          request,
          env,
          explicitMode,
        );
        if (tenantSegment instanceof Response) return tenantSegment;

        // `/s/<id>` and `/s/<id>/` (no inner path) → serve the xterm UI shell.
        if (route.innerPath === '/' || route.innerPath === '') {
          if (env.ASSETS) {
            const shellUrl = new URL('/s/index.html', url.origin);
            return env.ASSETS.fetch(new Request(shellUrl.toString(), {
              method: 'GET',
              headers: request.headers,
            }));
          }
          return new Response(
            '<!DOCTYPE html><meta http-equiv="refresh" content="0; url=/"><title>Nimbus</title>',
            { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          );
        }

        // Best-effort fire onSessionStart on WebSocket upgrade. Hooks
        // never block: schedule via ctx.waitUntil.
        if (hooks.onSessionStart && request.headers.get('Upgrade') === 'websocket') {
          try {
            const p = Promise.resolve(
              hooks.onSessionStart({
                tenantSegment,
                sessionId: route.sessionId,
                request,
                env,
              }),
            ).catch((e: any) =>
              console.warn('[nimbus] onSessionStart hook threw:', e?.stack || e),
            );
            (ctx as any)?.waitUntil?.(p);
          } catch (e: any) {
            console.warn('[nimbus] onSessionStart hook threw synchronously:', e);
          }
        }

        return forwardToSession(request, route, env, { tenantSegment });
      }

      // ── Back-compat legacy root paths → landing page ────────────────
      if (isLegacyRootPath(url.pathname)) {
        return new Response(null, {
          status: 302,
          headers: { Location: '/', 'Cache-Control': 'no-store' },
        });
      }

      return new Response('Not found', { status: 404 });
    },
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────

const LEGACY_ROOT_PATHS = ['/ws', '/api/', '/preview', '/worker', '/__nimbus/', '/port/'];
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

/**
 * Decide which tenant segment to use for DO naming. Returns either the
 * segment string or a short-circuit Response (auth failure).
 *
 * Mode `'auto'`:
 *   - If JWT_SECRET is set AND legacy env var not "1" → enforce verify.
 *   - Otherwise → legacy public.
 *
 * Mode `'enforce'`: always verify; 401 on missing/invalid token.
 *
 * Mode `'legacy'`: always legacy public.
 */
async function resolveTenantSegment(
  request: Request,
  env: any,
  explicitMode: AuthMode | undefined,
): Promise<string | Response> {
  const envLegacyFlag = (env?.NIMBUS_LEGACY_PUBLIC === '1' || env?.NIMBUS_LEGACY_PUBLIC === true);
  const hasSecret = typeof env?.JWT_SECRET === 'string' && env.JWT_SECRET.length > 0;
  const mode: AuthMode = explicitMode
    ?? (hasSecret && !envLegacyFlag ? 'enforce' : 'legacy');

  if (mode === 'legacy') return LEGACY_PUBLIC_DO_SEGMENT;

  if (!hasSecret) {
    // Enforce mode but no secret — config error. 500, no info leak.
    console.error('[nimbus] auth.mode="enforce" but JWT_SECRET is missing');
    return new Response(
      JSON.stringify({ error: 'Server auth misconfigured', code: 'E_AUTH_CONFIG_MISSING' }),
      { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const verified = await verifyRequestToken(request, env as NimbusAuthEnv);
    return verified!.doInstanceName;
  } catch (e) {
    if (e instanceof NimbusAuthError) {
      return authErrorResponse(e);
    }
    if (e instanceof NimbusTokenMalformedError) {
      return authErrorResponse(e);
    }
    console.error('[nimbus] unexpected auth error:', e);
    return new Response(
      JSON.stringify({ error: 'Internal auth error', code: 'E_AUTH_UNKNOWN' }),
      { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }
}
