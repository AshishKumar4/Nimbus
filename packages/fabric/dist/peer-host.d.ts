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
    method: string;
    url: string;
    headers: [string, string][];
    body: ReadableStream | null;
}
export interface HostedHttpResponse {
    status: number;
    statusText: string;
    headers: [string, string][];
    body: ReadableStream | null;
}
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
/** What the object hosting processes supplies: the two things the fabric cannot know. */
export interface PeerHostOptions {
    /**
     * The boot-spec schema with the embedder's own stage
     * (residentBootSpecSchema): the host leg is this peer's trust boundary for
     * what it boots.
     */
    bootSpec: z.ZodType<ResidentBootSpec>;
    /**
     * Arm the hosting watch through the object's own scheduler: a session's
     * timer mux, or an embedder's lifecycle, which owns its alarm.
     */
    scheduleWatch(at: number): Promise<void>;
}
/**
 * How often a host holding a process looks for its own reset: the resident
 * keep-alive's cadence, so the session learns of it within one cadence.
 */
export declare const HOSTING_WATCH_MS = 5000;
/**
 * The processes this Durable Object hosts for its siblings, and every leg a
 * coordinator's {@link PeerProcessHost} calls on it. One per object: its
 * records are this instance's memory, and its hosting rows are the storage a
 * next incarnation reads to report what the platform reset under it.
 */
export declare class PeerHost {
    private readonly ctx;
    private readonly options;
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
    /**
     * Host a resident process. Held open by the coordinator for the process's
     * whole life, and it is that held call which keeps this object resident —
     * the hosting watch is armed to report a reset, never to wake a host back
     * up. Resolves when the coordinator releases the process; rejects if it
     * could not be opened at all.
     *
     * The runner's start CONTRACT never crosses. The coordinator's fabric decides
     * from it when the process is over and releases, which cancels this call — so
     * this leg holds uniformly and has no idea whether it is hosting a TUI or a
     * server.
     *
     * If the coordinator dies, workerd cancels this inbound call, the facet is
     * released in the `finally` below, and the process dies with it: a hosting
     * peer never outlives its parent session.
     */
    host(boot: unknown, opts: unknown): Promise<{
        ok: boolean;
    }>;
    /**
     * Settle once the process is OPEN on this peer, or reject with whatever
     * stopped it from opening.
     *
     * This exists so a host failure surfaces at the same place on both substrates.
     * Opening a facet of your own DO either throws or does not, before the fabric
     * has a handle; opening one on a peer is a message, and without this the
     * coordinator would return a handle for a process that never existed and only
     * discover it later, through `done`.
     */
    awaitOpen(workerKey: string): Promise<{
        ok: boolean;
    }>;
    /**
     * Read back the runner's startProcess payload. `host` started it; this
     * never starts anything, so a coordinator asking twice gets the same answer
     * a local facet would have returned inline — and for a `lifetime` runner it
     * settles at exit, exactly as the local one does.
     */
    awaitBoot(workerKey: string): Promise<{
        payload: unknown;
    }>;
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
     * what leaves here must not be an object the loaded worker owns.
     */
    routeHttp(workerKey: string, wire: HostedHttpRequest): Promise<HostedHttpResponse>;
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
     * happened. The facet is released HERE rather than left to the held call's
     * `finally`, because a caller that has to guess whether the process is really
     * gone cannot retire the writer identity behind it.
     */
    cancel(workerKey: string): Promise<{
        cancelled: boolean;
    }>;
    /**
     * The hosting alarm. A row whose process this incarnation does not hold is
     * one the platform reset this object under (a new incarnation remembers
     * nothing of the processes it held, and the held leg that would have said so
     * may stay open, measured 2026-10-07): the session is told at once, and the
     * row is dropped once the session has answered, whatever it answered. A row
     * the session did not hear about is kept, and so is the watch: the next
     * alarm tells it again. A failure to read or drop the rows is retried the
     * same way, since the dispatcher forgets a reason whose handler throws.
     * Answers when to look again, or null when nothing is left to watch.
     */
    watchFired(): Promise<number | null>;
    /** One that cannot be armed throws, and the host refuses the process rather than hold one nothing would report the loss of. */
    private armWatch;
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