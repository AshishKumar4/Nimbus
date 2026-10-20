/**
 * peer-host.ts — the hosting side of the `peer` substrate (process-host.ts),
 * and the wire both sides speak.
 *
 * THIS Durable Object hosts a process for a sibling coordinator: it opens the
 * process as a facet of ITSELF — the same `processes().spawn` call the
 * coordinator makes when it hosts one directly — so the facet lands in this
 * object's workerd process, with its own memory AND its own CPU. The facet's
 * SUPERVISOR binding is minted for the COORDINATOR's doId, so every syscall
 * routes back to the user's session. Nothing here knows what the process is,
 * and nothing here decides anything: a coordinator reaches this side only
 * because its deployment chose `peer`.
 */
import { type WorkspaceEgress } from '@nimbus-sh/core/_shared/workspace-network.js';
import { z } from 'zod/v4';
import type { ResidentBootSpec } from './process-fabric.js';
export declare function isolateToken(): string;
/**
 * Options the coordinator hands a hosting peer. Parsed on the peer, because a
 * sibling accepts them from whoever calls it.
 */
declare const HostProcessOptsSchema: z.ZodObject<{
    coordinatorDoId: z.ZodString;
    route: z.ZodOptional<z.ZodObject<{
        supervisorEntrypoint: z.ZodString;
        hostNamespace: z.ZodString;
        hostDispatchMethod: z.ZodString;
    }, z.core.$strip>>;
    pid: z.ZodNumber;
    writerId: z.ZodString;
    hostIncarnation: z.ZodOptional<z.ZodString>;
    network: z.ZodOptional<z.ZodObject<{
        egress: z.ZodCustom<WorkspaceEgress, WorkspaceEgress>;
        id: z.ZodString;
    }, z.core.$strip>>;
    workerKey: z.ZodString;
    webSocketCapability: z.ZodString;
    startArgs: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
export type HostProcessOpts = z.infer<typeof HostProcessOptsSchema>;
/**
 * Inbound HTTP for a peer-hosted process travels as PARTS, not as a
 * Request/Response pair: workerd refuses to transfer an object owned by a
 * dynamically-loaded worker across a sibling-DO hop. Bodies are plain
 * ReadableStreams, which RPC carries with flow control, so nothing is buffered
 * and a live SSE body still streams.
 */
export interface HostedHttpRequest {
    capability: string;
    method: string;
    url: string;
    headers: [string, string][];
    body: ReadableStream | null;
    /** Its id, by which its coordinator can abandon it, the watermark below which the peer forgets, and abandons it carries (SentRequests). */
    id: number;
    low: number;
    abandoned?: number[];
}
export interface HostedHttpResponse {
    status: number;
    statusText: string;
    headers: [string, string][];
    body: ReadableStream | null;
}
/** A reply, or this host's loss: with the pid whose request it refused unsent (`notAdmitted`), when it did. */
export type HostedReply<T> = T | {
    hostLost: string;
    notAdmitted?: number;
};
export declare const HOSTED_WATCH_HEADER = "x-nimbus-hosted-watch";
export declare const HOSTED_RESIDENCY_HEADER = "x-nimbus-hosted-residency";
export declare const HOSTED_FAILURE_HEADER = "x-nimbus-hosted-failure";
/**
 * Which hosted process a fetched upgrade is for. An upgrade cannot travel as
 * RPC arguments, so the two values `_rpcRouteHostedHttp` would have taken ride
 * as headers on the peer fetch instead.
 *
 * The key alone is guessable from a pid, so it is not enough on its own; the
 * capability is minted per `open()` and known only to the coordinator that
 * opened the process and the peer that hosts it. PeerHost.routeWebSocket
 * strips both before the request reaches the process.
 */
export declare const HOSTED_WEBSOCKET_KEY_HEADER = "x-nimbus-hosted-websocket";
export declare const HOSTED_WEBSOCKET_CAPABILITY_HEADER = "x-nimbus-hosted-websocket-capability";
/**
 * Whether a fetch is the upgrade hop (PeerHost.routeWebSocket): a sibling
 * coordinator's request, not a browser's, and so answered before any route of
 * the object's own.
 */
export declare function isHostedWebSocket(request: Request): boolean;
export declare function isHostedWatch(request: Request): boolean;
export declare function isHostedResidency(request: Request): boolean;
/** The embedder's boot-spec authority. */
export interface PeerHostOptions {
    /**
     * The boot-spec schema with the embedder's own stage
     * (residentBootSpecSchema): the host leg is this peer's trust boundary for
     * what it boots.
     */
    bootSpec: z.ZodType<ResidentBootSpec>;
}
/**
 * The processes this Durable Object hosts for its siblings, and every leg a
 * coordinator's {@link PeerProcessHost} calls on it. One per object: its
 * records are this instance's memory, and its hosting rows are the storage a
 * next incarnation reads to report what the platform reset under it.
 */
export declare class PeerHost {
    private readonly ctx;
    private readonly options;
    private readonly incarnation;
    private readonly records;
    private readonly waiters;
    private readonly env;
    constructor(ctx: DurableObjectState, env: unknown, options: PeerHostOptions);
    /**
     * Placement probe: this peer's module-scope isolate token, so the
     * coordinator can verify the peer landed in a distinct workerd process — the
     * same token means a shared process, which is the CPU sharing a peer exists
     * to escape.
     */
    probe(): {
        isolateToken: string;
    };
    /** A hosting record's current physical actor, without admitting guest work. */
    inspect(workerKey: string): Promise<{
        found: boolean;
        incarnation: string;
        facet: string | null;
        coordinator: string | null;
        residencies: number;
        watchers: number;
    }>;
    /** Open once and answer. Observation and release are independently owned calls. */
    host(boot: unknown, opts: unknown): Promise<HostedReply<{
        ok: boolean;
        incarnation: string;
    }>>;
    /**
     * Read back the runner's startProcess payload. `host` started it; this
     * never starts anything, so a coordinator asking twice gets the same answer
     * a local facet would have returned inline — and for a `lifetime` runner it
     * settles at exit, exactly as the local one does.
     */
    awaitBoot(workerKey: string): Promise<HostedReply<{
        payload: unknown;
    } | {
        refused: unknown;
    }>>;
    /** The coordinator abandons request `id` of a process this peer hosts (SentRequests): its leaf's call is cancelled. */
    abandonHttp(workerKey: string, capability: string, id: number): Promise<void>;
    /**
     * Inbound HTTP for a port owned by a process this peer hosts.
     *
     * A `Request`/`Response` cannot cross a sibling-DO hop by reference — workerd
     * rejects it with "Entrypoints to dynamically-loaded workers cannot be
     * transferred to other Workers", because the object belongs to the
     * dynamically-loaded facet on the other side. Their PARTS travel fine, and a
     * body is a plain ReadableStream, which RPC transfers with flow control. So
     * the leg carries the parts and rebuilds the object on each side: no
     * buffering, no size ceiling, and an SSE or chunked body still flows live.
     *
     * The response body is re-piped through an identity stream owned by THIS
     * isolate before it is returned, for the same reason the parts exist at all:
     * what leaves here must not be an object the loaded worker owns. That
     * pipe's end is when this host's work for the response is done; the
     * coordinator abandons the request by its id (abandonHttp), which cancels its leaf's call,
     * before its headers or after, and the leaf's guest ending its body ends
     * the pipe.
     */
    routeHttp(workerKey: string, wire: HostedHttpRequest): Promise<HostedReply<HostedHttpResponse>>;
    /**
     * The peer end of the upgrade hop (isHostedWebSocket). Reached by `fetch`
     * rather than RPC, so the 101 and its live socket travel back as
     * themselves. Both headers are stripped so the process never sees the
     * transport that carried it.
     *
     * The workerKey names a process and is derivable from a pid, so it does not
     * authorise on its own; the capability is minted by whoever opened the process
     * and never leaves the two objects that hold it. A mismatch is a 404 and not
     * a 403, so the route reveals nothing about what this peer is hosting.
     */
    routeWebSocket(request: Request): Promise<Response>;
    /**
     * Deterministic kill of a hosted process — the same teardown a coordinator
     * applies to a facet of its own, and it does not answer until it has
     * happened: a caller that has to guess whether the process is gone cannot
     * retire the writer identity behind it.
     */
    cancel(workerKey: string): Promise<{
        cancelled: boolean;
    }>;
    /** One abortable observation bridges coordinator activity to this actor. */
    watch(request: Request): Promise<Response>;
    /** The coordinator retains its endpoint unaccepted; only the peer receives events. */
    reside(request: Request): Promise<Response>;
    private socket;
    private authorized;
    private gone;
    private answer;
    private register;
    /**
     * The record for `workerKey`, waiting briefly if the host leg has not landed
     * yet — the coordinator issues it first and it registers before its first
     * await, so normally there is nothing to wait for, but RPC delivery order is
     * not a guarantee.
     *
     * A host runs exactly ONE process: its Durable Object name carries the pid
     * (`<doId>:proc:<pid>:<attempt>`) and pids never repeat, being strided by
     * generation. So a key this host is not hosting is a key it never will host,
     * and parking a waiter for it would let anyone holding a stub to this object
     * accumulate map entries and 30-second timers here by the thousand. Once
     * something is known, an unknown key is refused immediately instead.
     */
    private awaitRecord;
}
/**
 * Headers as pairs, with every `Set-Cookie` kept separate.
 *
 * Iterating a `Headers` combines same-named fields into one comma-joined
 * value, and for `Set-Cookie` that is not reversible — `append` cannot split
 * `a=1; Path=/, b=2; Path=/` back into two cookies, and a browser reading the
 * merged form sets one malformed cookie instead of two. Every other field
 * combines by comma legally, so only this one needs the separate accessor.
 * A user's server setting two cookies must not depend on which substrate its
 * process happened to run on.
 */
export declare function headerPairs(headers: Headers): [string, string][];
export {};
//# sourceMappingURL=peer-host.d.ts.map