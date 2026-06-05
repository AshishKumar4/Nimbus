/**
 * session-router.ts — Rewrite `/s/<id>/<rest>` → DO-internal `/ <rest>`.
 *
 * Nimbus sessions live behind friendly URLs like `/s/nimble-otter-4271/`.
 * The Worker's fetch handler delegates to this module for anything that
 * starts with `/s/`. The DO itself remains blissfully ignorant of its
 * public URL: it sees `/ws`, `/api/*`, `/preview/*`, `/__nimbus/worker/*`
 * (and the deprecated `/worker/*`), `/port/<n>/*` — the same shape it
 * did in the single-session era.
 *
 * Session identity flows three places:
 *   1. The DO ID — derived via `env.NIMBUS_SESSION.idFromName(doName)`.
 *      `doName` is `${tenant}:${sub || '_'}:${sessionId}` when tenant
 *      scoping is on (JWT verified upstream); falls back to
 *      `legacy:public:_:${sessionId}` when `NIMBUS_LEGACY_PUBLIC === "1"`
 *      or `JWT_SECRET` is unset. The fallback preserves the live-demo
 *      single-tenant behavior while letting third-party embedders enforce
 *      tenant isolation by default. Caller (the worker fetch handler)
 *      passes `tenantSegment` in via {@link forwardToSession}.
 *   2. The `X-Nimbus-Base` request header — set to the URL-prefix the DO
 *      is mounted at (e.g. `/s/nimble-otter-4271`). ViteDevServer uses
 *      this to emit correct `<base href>`, module URLs, `import.meta.env
 *      .BASE_URL`, and router `basename` so the user's React app resolves
 *      `<NavLink to="/docs">` → `/s/nimble-otter-4271/preview/docs`.
 *   3. The `X-Nimbus-Tenant` request header — set to the verified
 *      `${tenant}:${sub}` so downstream RPC handlers can audit cross-
 *      session multi-tenancy invariants. Optional; never trusted as
 *      authority (the DO name itself is the trust boundary).
 *
 * Why a header instead of the DO auto-detecting?
 *   - The DO never sees the outer URL (we forward a rewritten Request).
 *   - Explicit plumbing is easier to test; auto-detect from Referer is
 *     unreliable (no Referer for API fetches from the xterm shell).
 *   - Single source of truth: this module owns the `/s/<id>/` mapping.
 */
/** Prefix for all session-scoped routes. Centralized for future refactors. */
export declare const SESSION_ROUTE_PREFIX = "/s";
/** Header the Worker sets on forwarded requests. The DO reads it. */
export declare const BASE_PATH_HEADER = "X-Nimbus-Base";
/**
 * Header the Worker sets to inform the DO of its tenant scope. The DO
 * reads it for audit-logging / RPC-routing; it does NOT use it for
 * authority — the DO instance name is the trust boundary.
 */
export declare const TENANT_HEADER = "X-Nimbus-Tenant";
/**
 * DO-name segment used when tenant scoping is disabled (legacy-public).
 * Picked so it cannot collide with a verified token's
 * `${tn}:${sub || '_'}` (because `legacy` is never a valid `tn` shape
 * starting with that exact prefix-then-colon when JWT_SECRET is set).
 */
export declare const LEGACY_PUBLIC_DO_SEGMENT = "legacy:public:_";
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
export declare function parseSessionRoute(pathname: string): ParsedSessionRoute | null;
/**
 * Options for {@link forwardToSession}.
 *
 * `tenantSegment` is the verified `${tn}:${sub || '_'}` from JWT, or
 * {@link LEGACY_PUBLIC_DO_SEGMENT} when running in legacy-public mode.
 * The worker fetch handler computes this BEFORE calling this function
 * — the router itself does not parse tokens.
 */
export interface ForwardOptions {
    /** Verified tenant segment for DO naming. */
    tenantSegment: string;
}
/**
 * Forward a request to the session's DO.
 *
 * Contract:
 *   - Caller has already validated the session ID (or tolerates whatever
 *     DO spawns if they didn't — still safe, but malformed IDs should be
 *     rejected upstream with 400).
 *   - Caller has already verified the token (or chosen legacy-public).
 *     We trust `opts.tenantSegment` verbatim.
 *   - Original request's method, body, and headers are preserved.
 *   - `X-Nimbus-Base` is injected so the DO can thread it into ViteDevServer.
 *   - WebSocket upgrades flow naturally: `stub.fetch()` returns a Response
 *     with a `webSocket` field and status 101, which workerd passes through.
 *
 * @param request The inbound Request. Method/body/headers preserved.
 * @param route Output of {@link parseSessionRoute}.
 * @param env Bindings env. Must carry `NIMBUS_SESSION` DO namespace.
 * @param opts Tenant scoping. See {@link ForwardOptions}.
 */
export declare function forwardToSession(request: Request, route: ParsedSessionRoute, env: any, opts: ForwardOptions): Promise<Response>;
/** HTML body for the "invalid session ID" 400 page. Tiny, inline-only. */
export declare function renderInvalidSessionHtml(attemptedId: string): string;
//# sourceMappingURL=session-router.d.ts.map