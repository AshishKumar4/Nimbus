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
 * Route a request to whatever is listening on a session port.
 *
 * The one implementation behind every port-addressed surface: `/port/<n>/`,
 * `/preview/?port=N`, and the `<port>--<sid>` preview hostname, which the
 * router forwards as `/port/<n>/`. They differ only in how the port and the
 * inner path are spelled, so they must not differ in what answers.
 *
 * `mountBase` is the public URL prefix the served app is mounted at for THIS
 * request — '' for a root-mounted `<port>--<sid>` host, '/s/<sid>/preview' for
 * the preview path. The in-process Cirrus dev server rewrites base-relative
 * URLs (module URLs, <base href>, BASE_URL, router basename), so it is handed
 * the base directly: the generic port proxy strips the Nimbus base header at
 * the untrusted-code boundary and cannot carry it, and a plain user server on
 * any other port is mounted at root and needs no rewriting.
 */
export declare function routeToSessionPort(self: RoutesHost, port: number, request: Request, innerPath: string, mountBase: string, capability?: string): Promise<Response>;
/** Route a capability-authenticated embedder request to a guest HTTP server. */
export declare function routeCapabilityPort(self: RoutesHost, port: number, capability: string, request: Request, innerPath: string): Promise<Response>;
/**
 * The name-addressed door: `/app/<name>/…` — what the scoped `<name>--<sid>`
 * host is forwarded as, and reachable in path form as `/s/<sid>/app/<name>/`.
 * The name is a reservation alias only this session's records know, so it
 * is resolved here and the request continues exactly as the port form would
 * — same routing, same durable re-drive, same capability gate. A name
 * nothing holds is a 404, never a guess.
 */
export declare function routeToSessionApp(self: RoutesHost, name: string, request: Request, innerPath: string, capability?: string): Promise<Response>;
export declare function handleFetch(self: RoutesHost, request: Request): Promise<Response>;
export {};
//# sourceMappingURL=routes.d.ts.map