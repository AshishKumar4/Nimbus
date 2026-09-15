/**
 * session/routes.ts — HTTP/WS fetch routing for the supervisor DO.
 *
 * One handleRequest function for everything the DO speaks:
 *   /ws upgrade        → cold-init / warm-rejoin (B'.5) / 409
 *   /preview/*         → cirrus-real or vite-dev-server forward
 *   /port/:n/*         → user http-server proxy via port-registry
 *   /worker/*          → nimbus-wrangler dev forward
 *   /api/_diag/*       → forensic surfaces (memory, session, cirrus)
 *   /api/_test/*       → NIMBUS_DEBUG-gated probe endpoints
 *   /api/* (other)     → small JSON endpoints (write-file, mkdir, ...)
 *
 * The dispatcher is one big if/else by design — pattern-matching
 * URL paths cleanly is easier to read than a Map-based router for
 * this many one-off shapes, and grep-ability matters when debugging.
 *
 * Surfaces:
 *   - handleFetch(self, request) — top-level dispatcher; was _handleFetch.
 *
 * The class retains `fetch` (DO contract) + `_handleFetch` as delegators
 * per plan §IX.4 R1.
 *
 * Per DEFECT-D1: route handlers read self.ctx + self.env extensively
 * (~30 sites). RoutesHost = any pragmatic deviation, like InitHost in S6.
 */
type RoutesHost = any;
/**
 * Restore the dev server a previous isolate left behind.
 *
 * Hibernation takes the ViteDevServer and the whole port registry with it;
 * only the `vite-config` blob survives in DO storage. Restoring it is the
 * first thing every route that can reach that server does, so a woken session
 * serves on all of them rather than on whichever one happened to carry the
 * restore.
 *
 * `onlyPort` scopes the restore to a config that would listen there: a
 * request for a port nothing ever persisted stays an honest 502, and a port
 * something else already holds is left alone.
 *
 * Idempotent, and silent on failure — a session with no dev server to restore
 * is the normal case, not an error.
 */
export declare function restorePersistedDevServer(self: RoutesHost, onlyPort?: number): Promise<void>;
/**
 * The name-addressed door: `/app/<name>/…` — what the scoped `<name>--<sid>`
 * host is forwarded as, and reachable in path form as `/s/<sid>/app/<name>/`.
 * The name is a reservation alias only this session's records know, so it
 * is resolved here and the request continues exactly as the port form would
 * — same routing, same durable re-drive, same capability gate. A name
 * nothing holds is a 404, never a guess.
 */
export declare function routeToSessionApp(self: RoutesHost, name: string, request: Request, innerPath: string, capability?: string): Promise<Response>;
/**
 * Accept a Vite HMR WebSocket for the running cirrus-real facet and wire it
 * into the facet's HMR bridge.
 *
 * Handled in the DO, never through the port-registry proxy: that proxy moves a
 * Request/Response over RPC and drops the `webSocket` handshake, so a HMR
 * upgrade routed through it hangs. This is the ONE place a preview HMR socket
 * is accepted — shared by the `/preview/` path and the `<port>--<sid>` host's
 * `/port/N` route, so HMR works the same on both.
 *
 * ctx.acceptWebSocket (hibernatable) is required because HMR messages arrive
 * from a DIFFERENT request context (the facet's long-poll RPC), and workerd
 * forbids cross-request I/O on a `server.accept()`'d socket.
 */
export declare function acceptCirrusHmrWs(self: RoutesHost, request: Request): Response;
export declare function handleFetch(self: RoutesHost, request: Request): Promise<Response>;
export {};
//# sourceMappingURL=routes.d.ts.map