/**
 * one-shot-peer.ts — a session's one-shots on its warm peer, and the wire
 * both sides speak.
 *
 * A one-shot's facet is a Loader worker its session calls, and that worker's
 * synchronous work runs on the session's own thread: while it runs, the
 * session answers nothing. Measured 2026-10-21 on throwaways: during a python
 * one-shot importing ten stdlib modules, a second terminal's echo, a request
 * to a running server and a file save each waited 3.1-3.4 s, against
 * 0.04-0.12 s with the same run on another Durable Object, whose worker runs
 * on that object's thread (verdict 20261021T111038-40692a3b802a).
 *
 * So a session keeps one sibling, its peer, and runs a one-shot there while
 * something besides the run wants the session's thread (#threadWanted) and
 * the peer is warm for it: when the
 * peer answered a call of the same worker within ONE_SHOT_WARM_MS. A wanted
 * thread and a cold peer run the call in the session as before, and warm the
 * peer for the next one beside it: a cold peer's first call cost 2.4-3.1 s
 * against 0.5-0.7 s warm, more than most runs hold the session, so it is
 * never paid on a call. An unwanted thread runs the call in the session and
 * warms nothing: there, a run is no faster on the peer (design-d1-placement-b.md).
 *
 * The run is the session's wherever it runs. Its SUPERVISOR binding is the
 * one the session minted for it (its pid, and so its credential; its
 * delivery incarnation and way back), so every syscall, stdio byte and write
 * reaches the session as that process, under the session's own filesystem
 * rules. The peer keeps nothing of a call past it: each call builds its pool
 * there from what it carries, and what a call receives ends with it. That is
 * also why a one-shot whose network goes out through an egress stays in the
 * session: a warm worker keeps the outbound it was loaded with, and on the
 * peer that would be one call's capability, ended with that call.
 */
import { z } from 'zod/v4';
import { type WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import type { Facet, FacetImage } from '@nimbus-sh/core/runtime/facet-host.js';
import { type IsolatePoolOptions } from './isolate-pool.js';
import type { SupervisorBindingProps } from './supervisor-props.js';
/**
 * How long a peer stays warm for a worker after it last answered a call of
 * it: the longest idle gap after which every measured peer was still warm.
 * Measured 2026-10-21 with a python one-shot on a peer after each gap:
 * - after 60, 75, 90, 105, 120 and 135 s idle, warm in 3 of 3 sessions
 *   (0.46-1.39 s, against 2.3-3.5 s for the same peer's first call;
 *   verdict 20261021T134050-9f15a2864f23);
 * - after 150 s idle, cold (2.2 s; verdict 20261021T111038-40692a3b802a).
 */
export declare const ONE_SHOT_WARM_MS = 135000;
/** A one-shot's pool, as both hosts build it, but for its images and network. */
export interface OneShotPoolSpec {
    tag: string;
    preamble?: string;
    concurrency?: number;
    /** The run's SUPERVISOR binding, minted by its session: absent for a facet that makes no syscall. */
    supervisor?: SupervisorBindingProps;
    reuse?: 'session' | 'global';
    /** The warm facet's scope (warmFacetScope): its worker takes its capability per call. */
    scope?: string;
}
/** `spec`'s pool on `network`, its images the constructor's (`images`) or each call's. */
export declare function oneShotPoolOptions(spec: OneShotPoolSpec, network: WorkspaceNetwork, images?: Record<string, FacetImage>): IsolatePoolOptions;
/**
 * A call's answer: the task's value, or what it failed with, which the peer
 * caught. The value is the task's own, what its source returns
 * (FacetTaskSource), which no RPC can check, as the session's own pool
 * cannot.
 */
declare function answerSchema<R>(): z.ZodDiscriminatedUnion<[z.ZodObject<{
    ok: z.ZodLiteral<true>;
    value: z.ZodCustom<R, R>;
    call: z.ZodNullable<z.ZodObject<{
        cold: z.ZodBoolean;
        loadMs: z.ZodNumber;
        callMs: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    ok: z.ZodLiteral<false>;
    message: z.ZodString;
    code: z.ZodOptional<z.ZodString>;
    unsettled: z.ZodBoolean;
}, z.core.$strip>, z.ZodObject<{
    ok: z.ZodLiteral<"preamble missing">;
}, z.core.$strip>], "ok">;
/** What may want a session's thread besides a run, as the session reads it (OneShotPlacement.wantedBy). */
export interface SessionDemand {
    /** Terminals with an open socket: the session's own and each named one. */
    terminals(): number;
    /** Ports a process of the session listens on. */
    ports(): number;
}
/** What /api/_diag/session shows of a session's one-shots: where each of the last ran, and its peer. */
export interface OneShotPlacementCall {
    tag: string;
    /** Its worker, as warmth knows it (workerOf): '' for one only the peer object's warmth decides. */
    worker: string;
    host: 'session' | 'peer';
    /** What wanted the session's thread as it started (#threadWanted): none, and it ran in the session. */
    wants: ThreadWant[];
    at: number;
}
/** What may want a session's thread while a one-shot computes there (OneShotPlacement #threadWanted). */
export type ThreadWant = 'terminal' | 'port' | 'run';
/** The placement of the one-shots of the Durable Object whose state is `ctx`, its peers in `env`'s host namespace. */
export declare function oneShotPlacement(ctx: DurableObjectState, env: object): OneShotPlacement;
/** What /api/_diag/session shows of a session's one-shot placement. */
export interface OneShotPlacementDiagnostics {
    peer: string | null;
    /** Each worker the peer is warm for, and how long since it answered a call of it (ms). */
    warm: Record<string, number>;
    calls: OneShotPlacementCall[];
    /** The last warming that failed, and why. */
    warmFailure: {
        worker: string;
        message: string;
        at: number;
    } | null;
}
/** Its peer and the last calls it placed, for /api/_diag/session; null before its first one-shot. */
export declare function oneShotPlacementDiagnostics(ctx: object): OneShotPlacementDiagnostics | null;
/**
 * Where each one-shot of one session runs. One per session object: what it
 * knows (which peer, and when it last answered a call of each worker) is
 * this incarnation's memory, and a new incarnation learns it again.
 */
export declare class OneShotPlacement {
    #private;
    constructor(ctx: DurableObjectState, env: object);
    /** What may want the session's thread besides a run, as its session reads it. */
    wantedBy(demand: SessionDemand): void;
    /**
     * A one-shot's facet: each call runs on the peer when the peer is warm for
     * its worker, else in this session. A local pool is opened either way: a
     * call the peer refused before it took it runs there. One whose network
     * goes out through an egress always runs here (the module's header says why).
     */
    facet(spec: OneShotPoolSpec, images: Record<string, FacetImage>, network: WorkspaceNetwork): Facet;
    /** The peer is cold for every worker, and found again by the next warming: a call to it failed. */
    forgetPeer(): void;
    diagnostics(): OneShotPlacementDiagnostics;
}
/** The one-shots the Durable Object whose state is `ctx` runs as a session's peer. */
export declare function oneShotHost(ctx: DurableObjectState, env: object): OneShotHost;
/**
 * The one-shots this Durable Object runs for its session, as that session's
 * peer: each call on a pool of its own, built from what the call carries
 * and gone with it, so nothing a call received outlives it. Only the
 * loader's warm workers stay, as they do for the session's own pools.
 */
export declare class OneShotHost {
    #private;
    private readonly ctx;
    private readonly env;
    constructor(ctx: DurableObjectState, env: object);
    /** One call of a session's facet: its answer, whatever the task did. */
    submit(spec: unknown, callId: unknown, fn: unknown, args: unknown, options: unknown, images: unknown): Promise<z.infer<ReturnType<typeof answerSchema<unknown>>>>;
    /** A facet's worker loaded here and left warm (IsolatePool.warm), running nothing. */
    warm(spec: unknown, fn: unknown, images: unknown): Promise<{
        warmed: true;
    }>;
    /** A call's kill: its wait for admission ends, as a session's own call's does. */
    cancel(callId: unknown): {
        cancelled: boolean;
    };
}
export {};
//# sourceMappingURL=one-shot-peer.d.ts.map