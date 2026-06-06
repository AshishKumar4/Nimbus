/**
 * router/index.ts — `createNimbusHandler` factory.
 *
 * The Worker entry's `default { fetch }` is a thin call into this
 * factory. Application embedders get the composable surface via
 * `@nimbus-sh/sdk/worker`:
 *
 *   import { NimbusSession, createNimbusHandler } from '@nimbus-sh/sdk/worker';
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
 *     "ship-Nimbus-as-is" case — exactly what `apps/hosted-demo/` does.
 */
import { generateSessionId, isValidSessionId, } from '../_shared/session-id.js';
import { parseSessionRoute, forwardToSession, renderInvalidSessionHtml, SESSION_ROUTE_PREFIX, LEGACY_PUBLIC_DO_SEGMENT, } from '../_shared/session-router.js';
import { verifyRequestToken, requireScopes, requireSessionPin, authErrorResponse, NimbusAuthError, NimbusTokenMalformedError, } from '../auth/index.js';
import { setCtxExports } from '../session/ctx-exports.js';
import { handleNimbusRemoteApi, } from './remote-api.js';
import { parseAgentOAuthStateParam } from '../session/agent.js';
/**
 * Build a Nimbus default-export handler. The returned object is exactly
 * what `export default` expects in a Workers entry module.
 *
 * @example minimal embedder
 * ```ts
 * import { NimbusSession, createNimbusHandler } from '@nimbus-sh/sdk/worker';
 * export { NimbusSession };
 * export default createNimbusHandler();
 * ```
 *
 * @example embedder with auth + a custom route
 * ```ts
 * import { NimbusSession, createNimbusHandler } from '@nimbus-sh/sdk/worker';
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
export function createNimbusHandler(options = {}) {
    const hooks = options.hooks ?? {};
    const customRoutes = options.routes;
    const authConfig = options.auth ?? {};
    // Resolve auth mode at factory-construction time.
    const explicitMode = authConfig.mode
        ?? (authConfig.legacyPublic ? 'legacy' : undefined);
    return {
        async fetch(request, env, ctx) {
            // Capture ctx.exports on first call (loopback bindings for facets).
            if (ctx?.exports)
                setCtxExports(ctx.exports);
            // Embedder custom routes run first.
            if (customRoutes) {
                try {
                    const r = await customRoutes(request, env, ctx);
                    if (r)
                        return r;
                }
                catch (e) {
                    console.error('[nimbus] custom route threw:', e?.stack || e);
                    return new Response('Internal error in embedder route', { status: 500 });
                }
            }
            const url = new URL(request.url);
            const sdkResponse = await handleNimbusRemoteApi(request, env, options.sdk);
            if (sdkResponse)
                return sdkResponse;
            if (url.pathname === '/api/nimbus/oauth/callback') {
                const payload = parseAgentOAuthStateParam(url.searchParams.get('state'));
                if (!payload || !isValidSessionId(payload.sessionId)) {
                    return new Response('Invalid OAuth state', { status: 400 });
                }
                return forwardToSession(request, {
                    sessionId: payload.sessionId,
                    innerPath: '/api/agent/oauth/callback',
                    basePath: `${SESSION_ROUTE_PREFIX}/${payload.sessionId}`,
                }, env, { tenantSegment: payload.tenantSegment });
            }
            // ── /new — spawn a fresh session and redirect ───────────────────
            if (url.pathname === '/new') {
                if (request.method !== 'POST' && request.method !== 'GET') {
                    return new Response('Method not allowed', { status: 405 });
                }
                const auth = await resolveNimbusRouteAuth(request, env, explicitMode, {
                    requiredScopes: ['session:create'],
                });
                if (auth instanceof Response)
                    return auth;
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
                // Resolve tenant segment per auth mode and enforce session attach
                // semantics. In enforced mode a sid-pinned token can only attach
                // to the exact session it was minted for.
                const auth = await resolveNimbusRouteAuth(request, env, explicitMode, {
                    requiredScopes: ['session:attach'],
                    sessionId: route.sessionId,
                });
                if (auth instanceof Response)
                    return auth;
                const tenantSegment = auth.tenantSegment;
                // `/s/<id>` and `/s/<id>/` (no inner path) → serve the xterm UI shell.
                if (route.innerPath === '/' || route.innerPath === '') {
                    if (env.ASSETS) {
                        const shellUrl = new URL('/s/index.html', url.origin);
                        return env.ASSETS.fetch(new Request(shellUrl.toString(), {
                            method: 'GET',
                            headers: request.headers,
                        }));
                    }
                    return new Response('<!DOCTYPE html><meta http-equiv="refresh" content="0; url=/"><title>Nimbus</title>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                }
                // Best-effort fire onSessionStart on WebSocket upgrade. Hooks
                // never block: schedule via ctx.waitUntil.
                if (hooks.onSessionStart && request.headers.get('Upgrade') === 'websocket') {
                    try {
                        const p = Promise.resolve(hooks.onSessionStart({
                            tenantSegment,
                            sessionId: route.sessionId,
                            request,
                            env,
                        })).catch((e) => console.warn('[nimbus] onSessionStart hook threw:', e?.stack || e));
                        ctx?.waitUntil?.(p);
                    }
                    catch (e) {
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
function isLegacyRootPath(pathname) {
    for (const p of LEGACY_ROOT_PATHS) {
        if (p.endsWith('/')) {
            if (pathname.startsWith(p))
                return true;
        }
        else {
            if (pathname === p || pathname.startsWith(p + '/'))
                return true;
        }
    }
    return false;
}
async function resolveNimbusRouteAuth(request, env, explicitMode, options = {}) {
    const envLegacyFlag = (env?.NIMBUS_LEGACY_PUBLIC === '1' || env?.NIMBUS_LEGACY_PUBLIC === true);
    const hasSecret = typeof env?.JWT_SECRET === 'string' && env.JWT_SECRET.length > 0;
    const mode = explicitMode
        ?? (hasSecret && !envLegacyFlag ? 'enforce' : 'legacy');
    if (mode === 'legacy') {
        return {
            tenantSegment: LEGACY_PUBLIC_DO_SEGMENT,
            verified: null,
        };
    }
    if (!hasSecret) {
        // Enforce mode but no secret — config error. 500, no info leak.
        console.error('[nimbus] auth.mode="enforce" but JWT_SECRET is missing');
        return new Response(JSON.stringify({ error: 'Server auth misconfigured', code: 'E_AUTH_CONFIG_MISSING' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    try {
        const verified = await verifyRequestToken(request, env);
        if (options.requiredScopes?.length) {
            requireScopes(verified, options.requiredScopes);
        }
        if (options.sessionId) {
            requireSessionPin(verified, options.sessionId);
        }
        return {
            tenantSegment: verified.doInstanceName,
            verified,
        };
    }
    catch (e) {
        if (e instanceof NimbusAuthError) {
            return authErrorResponse(e);
        }
        if (e instanceof NimbusTokenMalformedError) {
            return authErrorResponse(e);
        }
        console.error('[nimbus] unexpected auth error:', e);
        return new Response(JSON.stringify({ error: 'Internal auth error', code: 'E_AUTH_UNKNOWN' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
}
