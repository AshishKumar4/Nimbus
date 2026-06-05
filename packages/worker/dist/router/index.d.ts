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
import { type NimbusSdkRouterConfig } from './remote-api.js';
export type { NimbusConfig as NimbusSdkConfig, NimbusRemoteApiConfig, NimbusRuntimePolicy, NimbusSandboxProfile, NimbusSdkRouterConfig, } from './remote-api.js';
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
 * (not on every HTTP API call). `onSessionEnd` is reserved for future
 * session lifecycle events.
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
export type CustomRoutes = (request: Request, env: any, ctx: ExecutionContext) => Response | null | Promise<Response | null>;
/** Options for {@link createNimbusHandler}. */
export interface CreateNimbusHandlerOptions {
    /** Embedder hooks. All optional. */
    hooks?: NimbusHooks;
    /** Custom routes that run before Nimbus's router. */
    routes?: CustomRoutes;
    /** Auth-mode selector. Default `'auto'`. */
    auth?: NimbusAuthConfig;
    /** Programmatic SDK HTTP surface. Disabled unless explicitly enabled. */
    sdk?: NimbusSdkRouterConfig;
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
export declare function createNimbusHandler(options?: CreateNimbusHandlerOptions): NimbusHandler;
//# sourceMappingURL=index.d.ts.map