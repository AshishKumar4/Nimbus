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
 *   `request.method` and application headers mirror the outer request,
 *   Nimbus credentials/internal headers are removed, and
 *   `request.body` is a ReadableStream (or null for GET/HEAD) that
 *   the facet can consume once. The returned Response is streamed
 *   straight back, with one normalization: the hop speaks identity,
 *   so a compressed body is decoded here. See `decodeContentCoding`.
 */
import type { RouteableFacetTarget } from './os-contracts.js';
export interface PortEntry {
    port: number;
    pid: number;
    /**
     * Facet stub exposing `handleHttpRequest(Request): Promise<Response>`.
     * May be null when a facet has reserved a port but not yet wired up
     * the request handler (see _rpcRegisterPort in nimbus-session.ts).
     */
    facetStub: RouteableFacetTarget | null;
    registeredAt: number;
    /**
     * Unguessable token for the lifetime of THIS registration, so an embedder
     * can hand out one port's traffic without handing out the session. A fresh
     * one per `register`, which is what makes an unexposed port stay unexposed.
     */
    capability: string;
}
export declare class PortRegistry {
    private ports;
    private facetStubsByPid;
    private portWaitersByPid;
    /** Remember the available facet capabilities for a running process. */
    bindFacetStub(pid: number, facetStub: unknown): void;
    /**
     * Register a process as listening on a port. The route target comes from
     * the pid's binding — one target per process, owned by whoever started it —
     * so a port announced by the facet itself and one reserved by the spawn
     * resolve to the same handler.
     */
    register(port: number, pid: number): void;
    /** Unregister a port. */
    unregister(port: number): boolean;
    /** Unregister all ports owned by a specific PID. */
    unregisterByPid(pid: number): number;
    /** Look up a port entry. */
    get(port: number): PortEntry | undefined;
    /** Attach a normalized route target to ports previously reserved by a PID. */
    private attachFacetStubByPid;
    getRouteablePortsByPid(pid: number): number[];
    waitForRouteablePortsByPid(pid: number, timeoutMs: number): Promise<number[]>;
    /** Check if a port is registered. */
    has(port: number): boolean;
    /** Get all registered ports. */
    getAll(): PortEntry[];
    /** Answer only whether this capability matches, never what is registered. */
    hasCapability(port: number, capability: string): boolean;
    /**
     * Re-adopt a capability the embedder was already handed, after the supervisor
     * was rebuilt. A restored dev server is a NEW registration with a new token,
     * which would silently invalidate every preview URL already in circulation
     * across an eviction — so the durable value wins over the fresh one.
     */
    restoreCapability(port: number, capability: string): boolean;
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
     * port". Application headers and the body are forwarded; Nimbus
     * credentials and internal routing headers are removed before crossing
     * the user-code trust boundary. The body remains a ReadableStream so
     * binary payloads aren't materialised in memory.
     *
     * Binary safety: Workers RPC transfers Request/Response values with
     * their streaming bodies; it does not structured-clone them. No UTF-8
     * round-trip occurs anywhere.
     * A user-facet serving a PNG will return the exact same bytes the
     * client receives.
     */
    routeRequest(port: number, request: Request, pathname: string): Promise<Response | null>;
    /**
     * Route a request a trusted embedder has already authenticated against the
     * port's capability and stripped its own credentials from.
     *
     * Unlike the generic route, this one PRESERVES `Authorization`. The generic
     * route strips it because the header it sees is Nimbus's own, and handing a
     * session credential to untrusted code is the thing that must never happen.
     * Here the embedder has removed that credential already and what remains
     * belongs to the guest application, which needs it to authenticate its own
     * users.
     */
    routeCapabilityRequest(port: number, capability: string, request: Request, pathname: string): Promise<Response | null>;
    private routeRequestInternal;
    get stats(): {
        activePorts: number;
        ports: {
            port: number;
            pid: number;
        }[];
    };
    private waitForPidPortChange;
    private notifyPortWaiters;
}
//# sourceMappingURL=port-registry.d.ts.map