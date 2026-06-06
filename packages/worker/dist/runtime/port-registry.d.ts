/**
 * port-registry.ts — Maps virtual ports to facet stubs.
 *
 * When a facet calls http.createServer().listen(3000), it notifies the
 * supervisor via SupervisorRPC.registerPort(3000). The supervisor stores
 * the facet stub here. When the DO receives a request to /port/3000/*,
 * it looks up the facet and forwards the request.
 *
 * Transport (audit C2):
 *   The proxy forwards a real Request and returns a real Response.
 *   Workers RPC natively transfers Request/Response values between
 *   isolates with streaming bodies and flow control (they are NOT
 *   structured-cloneable — RPC has its own transfer mechanism for
 *   these types). Binary payloads (images, wasm, gzip, multipart
 *   uploads, audio/video) go through byte-for-byte with no UTF-8
 *   coercion or JSON envelope anywhere in the path.
 *
 *   Facet contract for handleHttpRequest:
 *     async handleHttpRequest(request: Request): Promise<Response>
 *
 *   where `request.url` is the inner URL the user's HTTP server
 *   expects (pathname + search, absolute against a synthetic origin),
 *   `request.method`/`headers` mirror the outer request, and
 *   `request.body` is a ReadableStream (or null for GET/HEAD) that
 *   the facet can consume once. The returned Response is returned
 *   to the outer fetch as-is; its body is streamed directly.
 */
export interface PortEntry {
    port: number;
    pid: number;
    /**
     * Facet stub exposing `handleHttpRequest(Request): Promise<Response>`.
     * May be null when a facet has reserved a port but not yet wired up
     * the request handler (see _rpcRegisterPort in nimbus-session.ts).
     */
    facetStub: any;
    registeredAt: number;
}
export declare class PortRegistry {
    private ports;
    private facetStubsByPid;
    /** Remember the routeable facet stub for a running process. */
    bindFacetStub(pid: number, facetStub: any): void;
    /** Register a facet as listening on a port. */
    register(port: number, pid: number, facetStub: any): void;
    /** Unregister a port. */
    unregister(port: number): boolean;
    /** Unregister all ports owned by a specific PID. */
    unregisterByPid(pid: number): number;
    /** Look up a port entry. */
    get(port: number): PortEntry | undefined;
    /** Attach a routeable facet stub to ports previously reserved by a PID. */
    attachFacetStubByPid(pid: number, facetStub: any): number[];
    /** Check if a port is registered. */
    has(port: number): boolean;
    /** Get all registered ports. */
    getAll(): PortEntry[];
    /**
     * Forward an HTTP request to the facet owning a port.
     *
     * Returns null if no facet is listening on this port (or if a port
     * is registered but its stub is not yet attached — see PortEntry).
     *
     * The Request passed to the facet has a rewritten URL whose pathname
     * is the inner path (without the `/port/<n>` prefix) and whose origin
     * matches the outer request, so user code reading `request.url`
     * sees a URL shape consistent with "my server is running at this
     * port". Headers and body are forwarded unchanged; the body is a
     * ReadableStream so binary payloads aren't materialised in memory.
     *
     * Binary safety: both directions use structured-cloneable Request/
     * Response values over Workers RPC. No UTF-8 round-trip anywhere.
     * A user-facet serving a PNG will return the exact same bytes the
     * client receives.
     */
    routeRequest(port: number, request: Request, pathname: string): Promise<Response | null>;
    get stats(): {
        activePorts: number;
        ports: {
            port: number;
            pid: number;
        }[];
    };
}
//# sourceMappingURL=port-registry.d.ts.map