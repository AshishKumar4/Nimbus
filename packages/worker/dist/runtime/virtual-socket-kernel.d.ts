/**
 * virtual-socket-kernel.ts - shared in-facet loopback socket substrate.
 *
 * The supervisor-facing surface stays the existing PortRegistry:
 * /port/<n>/ and /preview/?port=<n> route a real Worker Request to a
 * facet's handleHttpRequest(Request). Inside the facet this kernel
 * converts that Request into an accepted HTTP/1.1 byte stream so guest
 * runtimes can implement normal socket APIs without Cloudflare inbound
 * TCP support.
 *
 * Runtime adapters (Python socket.py, Ruby socket.rb, future
 * wasm32-wasi-nimbus syscalls) call this shared kernel instead of each
 * implementing their own preview bridge.
 *
 * This file is the typed source of truth. scripts/bundle-facet-workers.mjs
 * bundles it at build time into virtual-socket-kernel.generated.ts as the
 * self-contained VIRTUAL_SOCKET_KERNEL_SRC string that python-runner and
 * ruby-runner splice into dynamic worker module sources. Because that
 * bundle ships as injected source text, this module must stay free of
 * runtime imports - supervisor modules are unreachable from facet isolates.
 */
/** Hooks the per-runtime adapter glue installs on the facet global scope. */
export interface VirtualSocketHost {
    /** Called when a new port starts listening so the adapter can register it with the supervisor. */
    __nimbusVirtualSocketDidListen?: (port: number) => void;
    /** Gives the runtime a chance to (re)create a listener before a request 502s. */
    __nimbusVirtualSocketEnsureListener?: (port: number) => unknown;
    /**
     * Cooperative accept pump. Pyodide/ruby.wasm cannot run a background
     * accept loop (JSPI suspension is only legal on this dedicated pump),
     * so the kernel queues the connection and then asks the runtime to
     * process it. Returning false rejects the queued request.
     */
    __nimbusVirtualSocketRequestQueued?: (port: number) => Promise<boolean | undefined> | boolean | undefined;
    /** Detail string surfaced when the request pump returns false. */
    __nimbusVirtualSocketLastError?: string;
}
/** Facet global scope once the kernel is installed. */
export interface VirtualSocketGlobalScope extends VirtualSocketHost {
    __nimbusVirtualSockets?: VirtualSocketKernel;
}
/** Buffer and timing bounds enforced by the kernel. */
export interface VirtualSocketKernelLimits {
    /** How long handleHttpRequest waits for a complete response before answering 504. */
    responseTimeoutMs: number;
    /** Largest request body accepted into the inbound read queue (whole-body buffered in stage 1). */
    maxRequestBodyBytes: number;
    /** Largest total response byte count accepted into the outbound write queue (whole-response buffered in stage 1). */
    maxResponseBufferBytes: number;
}
/** Result shape of accept()/acceptNow(); host/port mirror a loopback peer. */
export interface AcceptedVirtualConnection {
    id: number;
    host: string;
    port: number;
}
/** Pyodide proxies cross the FFI boundary with a toJs() converter. */
interface PyodideProxyLike {
    toJs(): unknown;
}
/** Byte payloads accepted by send(); covers JS, Pyodide, and ruby.wasm callers. */
export type VirtualSocketBytesLike = Uint8Array | ArrayBuffer | ArrayBufferView | readonly number[] | string | PyodideProxyLike;
/**
 * Stage 2 contract: what the kernel must grow before request/response
 * bodies can stream end-to-end instead of being fully buffered. Stage 1
 * keeps the cooperative accept model (see
 * VirtualSocketHost.__nimbusVirtualSocketRequestQueued) - it exists
 * because Pyodide JSPI can only suspend inside the dedicated pump call,
 * so these members are the seam, not a replacement for that model.
 */
export interface VirtualSocketStreamingStage2 {
    /**
     * Suspending read for request bodies streamed into the inbound queue
     * chunk-by-chunk; replaces buffering the whole request before the
     * connection is pushed to the listener. Resolves null at EOF.
     */
    recvAsync(id: number, maxBytes: number): Promise<Uint8Array | null>;
    /**
     * Write-side backpressure: resolves once queued response bytes drop
     * below the high-water mark, replacing the hard
     * maxResponseBufferBytes cap with flow control.
     */
    awaitWritable(id: number): Promise<void>;
    /**
     * Headers-first streaming Response whose body is a ReadableStream fed
     * from the outbound queue. Requires the runtime pump to interleave
     * body writes with consumer reads instead of completing one whole
     * request per __nimbusVirtualSocketRequestQueued call.
     */
    streamHttpResponse(port: number, request: Request): Promise<Response>;
}
declare class VirtualConnection {
    readonly id: number;
    /** Request bytes the guest server reads; filled in one shot in stage 1. */
    private readonly inbound;
    /** Response bytes the guest server writes; drained into the parser. */
    private readonly outbound;
    private readonly parser;
    private readonly responseReady;
    private settled;
    private closed;
    constructor(id: number, requestMethod: string, requestBytes: Uint8Array, limits: VirtualSocketKernelLimits);
    read(maxBytes: number): number[];
    write(bytesLike: VirtualSocketBytesLike): number;
    /** EOF from the server side (or request teardown); completes until-close bodies. */
    close(): void;
    /** Abort propagation: settle the pending preview request with a terminal status. */
    abort(message: string, status: number): void;
    response(timeoutMs: number): Promise<Response>;
    private pumpParser;
    private settle;
}
declare class VirtualListener {
    readonly port: number;
    private readonly queue;
    private readonly acceptWaiters;
    constructor(port: number);
    push(conn: VirtualConnection): void;
    accept(): Promise<VirtualConnection>;
    take(): VirtualConnection | null;
    pending(): number;
    drainQueued(): VirtualConnection[];
    rejectPendingAccepts(error: Error): void;
}
export declare class VirtualSocketKernel {
    private readonly host;
    /** Public: runner glue inspects listeners.keys() for the default preview port. */
    readonly listeners: Map<number, VirtualListener>;
    private readonly connections;
    private readonly limits;
    private nextConnectionId;
    private nextEphemeralPort;
    private listenWaiters;
    private readonly readableWaiters;
    constructor(host: VirtualSocketHost, limits?: Partial<VirtualSocketKernelLimits>);
    listen(port: number): number;
    closeListener(port: number): void;
    accept(port: number): Promise<AcceptedVirtualConnection>;
    acceptNow(port: number): AcceptedVirtualConnection | null;
    /** Plain number array: Pyodide bytes() and the ruby.wasm base64 bridge both consume it. */
    recv(id: number, maxBytes: number): number[];
    send(id: number, bytesLike: VirtualSocketBytesLike): number;
    close(id: number): void;
    pending(port: number): number;
    firstListeningPort(): number | null;
    /** select()-style readiness: resolves ports with queued connections, [] on timeout. */
    waitReadable(ports: readonly number[], timeoutSeconds?: number | null): Promise<number[]>;
    waitForListen(timeoutMs?: number): Promise<number | null>;
    handleHttpRequest(port: number, request: Request): Promise<Response>;
    private notifyReadable;
}
/**
 * Install the kernel on the facet global scope. The generated injection
 * bundle (VIRTUAL_SOCKET_KERNEL_SRC) is exactly this call against
 * globalThis, wrapped in an IIFE so no identifiers leak into the dynamic
 * worker module scope.
 */
export declare function installVirtualSocketKernel(scope?: VirtualSocketGlobalScope): VirtualSocketKernel;
export {};
//# sourceMappingURL=virtual-socket-kernel.d.ts.map