/**
 * When a Durable Object's thread was held, and what was running then.
 *
 * The facets a session loads share its thread. A facet's long synchronous
 * slice keeps the session from dequeuing anything, its own calls and its
 * users' requests alike, and the platform refuses them all once the oldest
 * has waited too long ("Durable Object is overloaded. Requests queued for
 * too long."). The facets' own spans are not exported, so the session
 * watches for it itself: while work is in flight, it schedules a tick every
 * STALL_TICK_MS, and a tick that runs STALL_RECORDED_MS or more late is a
 * stall, recorded with the work in flight across it (`/api/_diag/session`).
 * A Worker's clock moves only between events, so a tick's lateness is
 * exactly how long its event waited for the thread.
 */
/** A stall: when its tick was due, how late it ran, and the work in flight across it. */
export interface ThreadStall {
    at: number;
    ms: number;
    inFlight: string[];
}
export declare const STALL_RECORDED_MS = 250;
/**
 * `name` in flight on `ctx`'s thread until the returned release is called:
 * while anything is, `ctx` watches its thread for stalls. The tick due when
 * the last work ends still runs, once, so a stall that work caused is
 * recorded though it ended first. Released twice is released once.
 */
export declare function holdThreadWatch(ctx: object, name: string): () => void;
/** `ctx`'s last STALLS_KEPT stalls, oldest first. */
export declare function recentThreadStalls(ctx: object): ThreadStall[];
//# sourceMappingURL=thread-stalls.d.ts.map