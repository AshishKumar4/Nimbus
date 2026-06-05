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
export declare function handleFetch(self: RoutesHost, request: Request): Promise<Response>;
export {};
//# sourceMappingURL=routes.d.ts.map