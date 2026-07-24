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
import { buildPreviewHost, isPreviewHostSafeSid, parsePreviewHost, readPreviewHostSuffix, } from '../_shared/preview-host.js';
import { parseSessionRoute, forwardToSession, renderInvalidSessionHtml, SESSION_ROUTE_PREFIX, LEGACY_PUBLIC_DO_SEGMENT, } from '../_shared/session-router.js';
import { issueNimbusToken, verifyNimbusToken, verifyRequestToken, requireScopes, requireSessionPin, authErrorResponse, setNimbusTokenCookie, NIMBUS_TOKEN_QUERY, NimbusAuthError, NimbusBootstrapConsumedError, NimbusTokenClaimsError, DEFAULT_TOKEN_TTL_MS, ATTACH_BOOTSTRAP_TTL_MS, } from '../auth/index.js';
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
    async function route(request, env, ctx) {
        // Capture ctx.exports on first call (loopback bindings for facets).
        if (ctx?.exports)
            setCtxExports(ctx.exports);
        const url = new URL(request.url);
        const previewSuffix = readPreviewHostSuffix(env);
        // ── <port>--<sid>.<suffix> — port preview ───────────────────────
        // FIRST, ahead of embedder routes and every control-plane path: the
        // previewed app is untrusted code mounted at this origin's root and
        // owns the whole path space. A Nimbus route answering here would both
        // shadow the app's own `/login` or `/new` and put a control-plane
        // endpoint same-origin with attacker-authored JavaScript.
        const preview = parsePreviewHost(url.host, previewSuffix);
        if (preview) {
            if (!isValidSessionId(preview.sid)) {
                return new Response(renderInvalidSessionHtml(preview.sid), {
                    status: 400,
                    headers: {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-store',
                    },
                });
            }
            if (request.method === 'GET'
                && request.headers.get('Upgrade') !== 'websocket'
                && url.searchParams.get(NIMBUS_TOKEN_QUERY)
                && resolveAuthMode(env, explicitMode) === 'enforce') {
                // Land on the path that was actually requested — the app owns it;
                // the exchange only strips the token from the query.
                return handleAttachExchange(url, preview.sid, env, {
                    redirectPath: url.pathname,
                    singleUseScope: 'session:preview',
                    reusableScope: null,
                });
            }
            const auth = await resolveNimbusRouteAuth(request, env, explicitMode, {
                requiredScopes: ['session:attach'],
                sessionId: preview.sid,
            });
            if (auth instanceof Response)
                return auth;
            return forwardToSession(request, {
                sessionId: preview.sid,
                innerPath: `/port/${preview.port}${url.pathname === '/' ? '/' : url.pathname}`,
                basePath: '',
            }, env, { tenantSegment: auth.tenantSegment });
        }
        // Embedder custom routes run first among the control-plane routes.
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
            // Authenticated creates get an attach URL carrying a short-lived,
            // single-use, sid-pinned bootstrap token. The caller's long-lived
            // token never appears in a URL; the bootstrap is exchanged for the
            // session cookie on first visit (see the attach exchange below).
            let location = `${SESSION_ROUTE_PREFIX}/${sessionId}/`;
            if (auth.verified) {
                const bootstrap = await issueNimbusToken(env, {
                    tn: auth.verified.claims.tn,
                    ...(auth.verified.claims.sub !== undefined && { sub: auth.verified.claims.sub }),
                    scopes: ['session:bootstrap'],
                    sid: sessionId,
                    jti: crypto.randomUUID(),
                }, { ttlMs: ATTACH_BOOTSTRAP_TTL_MS });
                location += `?${new URLSearchParams({ [NIMBUS_TOKEN_QUERY]: bootstrap })}`;
            }
            return new Response(null, {
                status: 302,
                headers: {
                    Location: location,
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
            // Attach exchange: a token arriving via `?nimbus_token=` on the
            // session shell URL is exchanged for the session cookie, then the
            // browser is redirected to the clean `/s/<id>/` URL. This is the
            // only place query tokens produce cookies; WebSocket upgrades and
            // API requests never do.
            if (route.innerPath === '/'
                && request.method === 'GET'
                && request.headers.get('Upgrade') !== 'websocket'
                && url.searchParams.get(NIMBUS_TOKEN_QUERY)
                && resolveAuthMode(env, explicitMode) === 'enforce') {
                return handleAttachExchange(url, route.sessionId, env, {
                    redirectPath: `${SESSION_ROUTE_PREFIX}/${route.sessionId}/`,
                    singleUseScope: 'session:bootstrap',
                    reusableScope: 'session:attach',
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
            if (route.innerPath === '/api/preview-url' && request.method === 'GET') {
                const rawPort = url.searchParams.get('port');
                const port = rawPort && /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
                if (!Number.isInteger(port) || port < 1 || port > 65535) {
                    return Response.json({ error: 'Invalid port' }, {
                        status: 400,
                        headers: { 'Cache-Control': 'no-store' },
                    });
                }
                if (!previewSuffix || !isPreviewHostSafeSid(route.sessionId)) {
                    return Response.json({ url: null, reason: 'unavailable' }, { headers: { 'Cache-Control': 'no-store' } });
                }
                let previewUrl = `https://${buildPreviewHost(route.sessionId, port, previewSuffix)}/`;
                if (auth.verified) {
                    // Same shape as the `POST /new` bootstrap: short-lived,
                    // sid-pinned, single-use (`jti`), and scoped to the preview
                    // exchange alone. A preview URL is a link — it lands in history,
                    // referrers and chat logs — so it must not be replayable, and it
                    // must not authenticate anything but this one exchange.
                    const token = await issueNimbusToken(env, {
                        tn: auth.verified.claims.tn,
                        ...(auth.verified.claims.sub !== undefined && { sub: auth.verified.claims.sub }),
                        scopes: ['session:preview'],
                        sid: route.sessionId,
                        jti: crypto.randomUUID(),
                    }, { ttlMs: ATTACH_BOOTSTRAP_TTL_MS });
                    previewUrl += `?${new URLSearchParams({ [NIMBUS_TOKEN_QUERY]: token })}`;
                }
                return Response.json({ url: previewUrl }, { headers: { 'Cache-Control': 'no-store' } });
            }
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
        // Not a Nimbus route. Embedders that ship static assets run the Worker
        // first (host-based preview routing needs every request), so unclaimed
        // paths are served from the assets binding here rather than by the
        // edge short-circuiting the Worker.
        if (env.ASSETS)
            return env.ASSETS.fetch(request);
        return new Response('Not found', { status: 404 });
    }
    return {
        async fetch(request, env, ctx) {
            try {
                return await route(request, env, ctx);
            }
            catch (e) {
                // With `run_worker_first`, this handler is the entry point for the
                // marketing site and the docs as well as the app, so an uncaught
                // throw would take the whole public surface down.
                console.error('[nimbus] unhandled router error:', e?.stack || e);
                return new Response('Internal error', {
                    status: 500,
                    headers: { 'Cache-Control': 'no-store' },
                });
            }
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
/** Resolve the effective auth mode. Single source of truth for the
 *  `'auto'` heuristic (JWT_SECRET present + legacy flag unset → enforce). */
function resolveAuthMode(env, explicitMode) {
    const envLegacyFlag = (env?.NIMBUS_LEGACY_PUBLIC === '1' || env?.NIMBUS_LEGACY_PUBLIC === true);
    const hasSecret = typeof env?.JWT_SECRET === 'string' && env.JWT_SECRET.length > 0;
    return explicitMode ?? (hasSecret && !envLegacyFlag ? 'enforce' : 'legacy');
}
async function resolveNimbusRouteAuth(request, env, explicitMode, options = {}) {
    const hasSecret = typeof env?.JWT_SECRET === 'string' && env.JWT_SECRET.length > 0;
    const mode = resolveAuthMode(env, explicitMode);
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
        console.error('[nimbus] unexpected auth error:', e);
        return new Response(JSON.stringify({ error: 'Internal auth error', code: 'E_AUTH_UNKNOWN' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
}
/**
 * Exchange a `?nimbus_token=` query token for the session cookie, then
 * redirect to `redirectPath` on the same host with the token stripped.
 *
 * Two token kinds exist, and each entry point declares which it accepts:
 *   - Single-use, server-minted tokens (`jti` present). The `jti` is
 *     consumed set-if-absent in the session DO's storage, so a replayed URL
 *     gets a 401. `POST /new` mints `session:bootstrap`; `/api/preview-url`
 *     mints `session:preview`. Neither scope grants anything else, so the
 *     link in the browser's history is not a session credential.
 *   - Reusable embedder iframe tokens (no `jti`, `session:attach` scope)
 *     from `<NimbusTerminal>` / `sessionAttachUrl`. Only the `/s/` shell
 *     accepts these; on a preview host `reusableScope` is null and they are
 *     rejected.
 *
 * Either way the cookie holds a FRESHLY minted sid-pinned `session:attach`
 * token — the presented token (and whatever extra scopes it carried) is
 * never persisted browser-side. Single-use exchanges get the default session
 * cookie lifetime; embedder tokens keep their own remaining lifetime.
 */
async function handleAttachExchange(url, sessionId, env, options) {
    const token = url.searchParams.get(NIMBUS_TOKEN_QUERY);
    try {
        const verified = await verifyNimbusToken(env, token);
        requireSessionPin(verified, sessionId);
        let cookieTtlMs;
        if (verified.claims.jti !== undefined) {
            requireScopes(verified, [options.singleUseScope]);
            // Single-use tokens are always sid-pinned. A jti without a sid would
            // consume independently in every session DO it is tried against, so
            // reject it outright instead of trusting the mint site.
            if (verified.claims.sid === undefined) {
                throw new NimbusTokenClaimsError('single-use attach token missing sid');
            }
            const fresh = await consumeAttachBootstrap(env, verified.doInstanceName, sessionId, verified.claims.jti);
            if (!fresh)
                throw new NimbusBootstrapConsumedError();
            cookieTtlMs = DEFAULT_TOKEN_TTL_MS;
        }
        else {
            if (options.reusableScope === null) {
                throw new NimbusTokenClaimsError('attach token must be single-use here');
            }
            requireScopes(verified, [options.reusableScope]);
            cookieTtlMs = Math.max(1000, verified.claims.exp * 1000 - Date.now());
        }
        const cookieToken = await issueNimbusToken(env, {
            tn: verified.claims.tn,
            ...(verified.claims.sub !== undefined && { sub: verified.claims.sub }),
            scopes: ['session:attach'],
            sid: sessionId,
        }, { ttlMs: cookieTtlMs });
        const cookieExpSec = Math.floor(Date.now() / 1000) + Math.floor(cookieTtlMs / 1000);
        const clean = new URL(url);
        clean.searchParams.delete(NIMBUS_TOKEN_QUERY);
        clean.pathname = options.redirectPath;
        return new Response(null, {
            status: 302,
            headers: {
                Location: clean.pathname + clean.search,
                'Set-Cookie': setNimbusTokenCookie(cookieToken, cookieExpSec),
                'Cache-Control': 'no-store',
            },
        });
    }
    catch (e) {
        if (!(e instanceof NimbusAuthError)) {
            console.error('[nimbus] attach exchange error:', e);
        }
        return authErrorResponse(e);
    }
}
/** Consume a bootstrap `jti` in the session DO — set-if-absent. False = replay. */
function consumeAttachBootstrap(env, tenantSegment, sessionId, jti) {
    const id = env.NIMBUS_SESSION.idFromName(`${tenantSegment}:${sessionId}`);
    return env.NIMBUS_SESSION.get(id)._rpcConsumeAttachBootstrap(jti);
}
