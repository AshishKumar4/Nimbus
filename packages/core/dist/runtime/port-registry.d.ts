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
import { type DocumentPolicy } from './document-policy.js';
import { type ResponseScope, type RouteableFacetTarget } from './os-contracts.js';
import type { ProcessOutput } from './output-gate.js';
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
    /**
     * The isolation headers of the last document this registration served (a
     * navigation's non-redirect response), null until it serves one. The shell
     * reads it from `stats` to decide what the preview pane can offer.
     */
    document: DocumentPolicy | null;
}
/**
 * Hand back a port target's response with its bytes and its headers in
 * agreement.
 *
 * A `Response` a facet builds always holds an identity body. The runtime
 * treats the bytes a `Response` is constructed from as unencoded and runs its
 * own content negotiation on the way out: it drops a `Content-Encoding` the
 * client did not ask for, and compresses again when the client did. Either
 * way a guest server's `Content-Encoding` is a label with nothing behind it,
 * and the browser renders compressed bytes as text.
 *
 * The forwarded request asks the target for `identity`, so this decode covers
 * the server that compresses whatever the client said. A coding with no
 * decoder answers 502: an honest failure beats a page of mojibake.
 */
/**
 * Hand a body that arrived over Workers RPC to the HTTP layer through a stream
 * this isolate owns. Measured on workerd 1.20260918.1: a facet's Response built
 * from bytes (`Response.json`, a string, a Uint8Array) and returned as-is ends
 * with the facet's side of the RPC stream failing "disconnected prematurely"
 * after every byte has arrived, which marks the request as an exception and,
 * under a compressing edge, truncates the body; a body read by this isolate
 * closes cleanly. A body the facet streamed (`new Response(readable)`) was
 * never affected, and rides the same pipe at no cost.
 *
 * The pipe keeps the target's `Content-Length`. The runtime sends a body built
 * from any stream chunked, dropping the header, except a `FixedLengthStream`,
 * whose length becomes the `Content-Length`:
 * https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream
 * A range reader sizes its buffer from it and a download reports progress by
 * it, so a declared length is relayed through one. It errors the body if the
 * target sends a different number of bytes, as HTTP framing would. A HEAD
 * answer's length describes the GET it stands for, not the body it has none
 * of, so it is not held to it.
 *
 * The pipe into the last stage is explicit, so its settlement is when the
 * body is done with: its end (`owner.settle`), or its failure, `owner.signal`
 * aborting it among them (`owner.fail`).
 */
export declare function relayRpcBody(response: Response, method: string, owner: BodyOwner, gated?: TransformStream<Uint8Array, Uint8Array> | null): Response;
/** Who owns work for a relayed body: it ends with `signal`, and says how the relay ended. */
export interface BodyOwner {
    readonly signal: AbortSignal;
    /** The response was delivered whole: its body's end, or no body. */
    settle(): void;
    /** The response will not be delivered, for any reason: to its handler, the caller has left. */
    fail(): void;
    /** The relay's JavaScript stage, errored if the caller leaves while it waits. */
    stage(controller: TransformStreamDefaultController<Uint8Array>): void;
}
export declare function responseScope(caller: AbortSignal): {
    scope: ResponseScope;
    owner: BodyOwner;
};
/**
 * `outer` (a Request's serialized URL) with its path replaced by `pathname`,
 * its query kept and its fragment dropped. Read off the serialization, which
 * is already normalized, rather than parsed again for every request; an
 * authority with userinfo, or a path that is not one, goes through URL.
 */
export declare function innerRequestUrl(outer: string, pathname: string): string;
export declare function createPortCapability(): string;
/**
 * The header a forwarded request carries its process's ACQUIRE in. An
 * `x-nimbus-*` name, so one a client sent is stripped before the hop
 * (`sanitizeUntrustedHeaders`). It is attached only for a process bound with
 * `deliversAcquire` (a node-shims resident), which removes it before its
 * handler sees the request; any other target would hand it to user code.
 */
export declare const DELIVERED_ACQUIRE_HEADER = "X-Nimbus-Vfs-Acquired";
export declare class PortRegistry {
    private readonly deliveredAcquire;
    private ports;
    private facetStubsByPid;
    /** Why a port's process ended, when it was told (unregisterByPid); until the port is registered again. */
    private endings;
    /** Pids whose target takes a delivered ACQUIRE off the request (see DELIVERED_ACQUIRE_HEADER). */
    private acquireDeliveredPids;
    private portWaitersByPid;
    /** Where a process's answers leave (setOutput). */
    private output;
    private clientSocketActivity;
    private readonly clientSockets;
    /**
     * @param deliveredAcquire What the owner of the filesystem attaches to a
     *   request routed to process `pid`: the ACQUIRE answer the process applies
     *   before its handler runs, in place of asking for one — a request is a
     *   resumption the supervisor delivers (session/rpc.ts
     *   `_acquireOnDelivery`). Undefined attaches nothing, and without it every
     *   request is forwarded bare; either way the process then asks.
     */
    constructor(deliveredAcquire?: ((pid: number) => Promise<unknown>) | null);
    /**
     * Let each process's answers out through `output` (its status and headers,
     * each piece of its body, and the body's end), as the rest of what it makes
     * visible: once what it wrote before is published. A socket an upgrade
     * hands it is one nothing there sees, which `output` is told. One slot.
     */
    setOutput(output: ProcessOutput | null): void;
    /** Routed preview sockets, not the embedder's unrelated socket table. */
    get clientSocketCount(): number;
    setClientSocketActivity(note: (() => void) | null): void;
    private clientSocket;
    /**
     * Remember the available facet capabilities for a running process.
     * `deliversAcquire`: the target strips DELIVERED_ACQUIRE_HEADER before user
     * code runs, so requests routed to it carry one.
     */
    bindFacetStub(pid: number, facetStub: unknown, { deliversAcquire }?: {
        deliversAcquire?: boolean;
    }): void;
    /**
     * Register a process as listening on a port. The route target comes from
     * the pid's binding — one target per process, owned by whoever started it —
     * so a port announced by the facet itself and one reserved by the spawn
     * resolve to the same handler.
     */
    register(port: number, pid: number): void;
    /**
     * Reserve an ephemeral port in the session, not in a guest isolate.
     * IANA's dynamic/private range is 49152–65535:
     * https://www.iana.org/assignments/service-names-port-numbers/
     * Reservation and selection are synchronous, so concurrent listen(0)
     * calls cannot receive the same number. Normal pid cleanup releases it.
     */
    allocate(pid: number): number;
    /** Unregister a port. */
    unregister(port: number): boolean;
    /**
     * Unregister all ports owned by a specific PID. `ending` says why its
     * process ended, for a request to one of those ports to be told (ended).
     */
    unregisterByPid(pid: number, ending?: string): number;
    /** Why the process that last served `port` ended, when it was told and nothing has registered the port since. */
    ended(port: number): string | undefined;
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
     *
     * A request the process refused unsent rejects with ProcessNotAdmitted,
     * never a 502: it ran nowhere, and its caller may run it again, its body
     * untouched.
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
            document: DocumentPolicy | null;
        }[];
    };
    private waitForPidPortChange;
    private notifyPortWaiters;
}
//# sourceMappingURL=port-registry.d.ts.map