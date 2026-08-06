/**
 * process-host.ts — the two substrates a resident process can run on, and the
 * one value that picks between them.
 *
 * `loaders/process-fabric.ts` owns what a resident process IS. This module
 * owns only where it lives, behind `ProcessHost`:
 *
 *   facet — the process is a named child actor of the user's own session DO.
 *   peer  — the process is a named child actor of a SIBLING session DO, and
 *           the coordinator reaches it over one held-open RPC.
 *
 * Both call the same `openResidentFacet`. The peer leg is not a second process
 * implementation; it is the same call made on a different actor, which is why
 * the runner, the boot spec, the class name, the writer handshake, the start
 * contract and the lifecycle are shared code rather than parallel paths.
 *
 * Choosing between them
 * ─────────────────────
 * `NIMBUS_PROCESS_HOST`, one var for the whole deployment. No spawn site
 * chooses; no program name, mode or payload size reaches the choice. If a
 * decision about a particular process ever appears here, the heavy/light
 * classifier has grown back and should be deleted again.
 *
 *   |          | spawn      | memory      | CPU        | SQLite |
 *   |----------|------------|-------------|------------|--------|
 *   | facet    | 8-16 ms    | independent | SHARED     | own    |
 *   | peer     | 242-359 ms | independent | independent| own    |
 *
 * Facet CPU is shared because facets are separate isolates inside ONE actor
 * thread: awaiting I/O yields it completely (measured 0 ms of sibling impact),
 * but a non-yielding loop stalls every sibling for its full duration
 * (measured 6,852 ms). A peer pays ~20x the spawn cost to buy that back.
 *
 * What the peer leg has to do differently, and why none of it reaches the
 * process
 * ────────────────────────────────────────────────────────────────────────
 *   payloads — a whole structured-clone RPC value is capped at 32 MiB, and
 *              pi's node snapshot alone serializes to 44,252,709 bytes. Boot
 *              specs name their large members BY PATH, so what crosses is a
 *              path and the host reads the bytes off the coordinator's disk in
 *              4 MiB ranges through the supervisor. Nothing large is ever an
 *              RPC argument, so nothing has to be streamed or replayed.
 *   requests — workerd refuses to transfer an object owned by a
 *              dynamically-loaded worker across a sibling-DO hop, so a request
 *              travels to the peer as PARTS and the response comes back as
 *              parts, both with plain `ReadableStream` bodies that RPC carries
 *              with flow control. A live SSE body still streams; nothing is
 *              buffered.
 *   liveness — the host leg is held open for the process's whole life, which
 *              is also what keeps the hosting DO resident. A peer therefore
 *              never outlives its coordinator: the coordinator dying cancels
 *              the inbound call and the facet dies with it. Nothing in this
 *              fabric arms an alarm, on either substrate.
 *
 * WebSockets are NOT in that list, because a resident process never receives
 * one. `RouteableFacetTarget` is `handleHttpRequest(Request): Promise<Response>`
 * and nothing else; no runner returns a 101 with a `webSocket` member; every
 * inbound socket Nimbus serves — the shell terminal, `/api/logs/<pid>`, vite
 * HMR — terminates on the session DO and reaches the process, if at all, as
 * events on a supervisor poll. That is substrate-independent by construction.
 */
import { type ProcessHost, type ResidentDiskReader } from './process-fabric.js';
/** The substrates this deployment can be configured for. */
export type ProcessHostMode = 'facet' | 'peer';
/**
 * The var that picks the substrate, and the only place its name appears.
 * Unset means `facet`; an unrecognized value is refused rather than defaulted,
 * because a typo that silently kept the old substrate would make an operator's
 * comparison a lie.
 */
export declare function processHostMode(env: unknown): ProcessHostMode;
/**
 * The substrate for this deployment, resolved once. `disk` is the
 * coordinator's own filesystem reader; the peer host does not take it, because
 * a peer reads the same disk through the supervisor instead.
 */
export declare function processHostFor(ctx: DurableObjectState, env: unknown, disk: () => ResidentDiskReader): ProcessHost;
export declare function isolateToken(): string;
/** Options the coordinator hands a hosting peer. */
export interface HostProcessOpts {
    coordinatorDoId: string;
    pid: number;
    writerId: string;
    workerKey: string;
    startArgs?: unknown;
}
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
//# sourceMappingURL=process-host.d.ts.map