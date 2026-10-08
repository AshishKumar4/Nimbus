/**
 * facet-pool.ts — leased facets, so reclaiming storage is the default and
 * leaking it takes intent.
 *
 * Proteus's facet-spawn.ts (313 lines) exists because the platform's two
 * teardown verbs are indistinguishable to a caller and only one gives
 * storage back: `abort` is mid-flight eviction with storage KEPT, `delete`
 * is terminal with storage WIPED. Its docstring records the cost of
 * confusing them: "the leak this module previously had, in which every head
 * and every MCTS branch abandoned a permanent database inside the
 * orchestrator DO". The lease makes that leak unreachable: disposal retires
 * the facet (evict, then wipe), and keeping storage is the explicit opt-in
 * (`detach()`, today's abort).
 *
 * The constraints a caller must not be surprised by, from Proteus's platform
 * catalog (all proven by probe or by source):
 *   - a facet cannot set alarms (`do.facet.no_alarms`) — a head cannot
 *     schedule its own resumption; everything time-driven routes through the
 *     root's single alarm (`timers`).
 *   - a facet stub is coordinator-local (`do.facet.stub_local`) — it cannot
 *     be transferred, stored, or re-invoked indirectly.
 *   - facet storage is charged to the ROOT's shared budget, and a clone that
 *     crosses it is an uncatchable reset, not an error (`do.storage.bytes`).
 *   - a parent and its facets are evicted JOINTLY after minutes idle, so
 *     in-memory facet state is never safe to assume between two RPCs.
 *   - live facets are bounded: one object failed at 32,240 facets none of
 *     which was deleted, and its storage then failed to start (measured
 *     2026-10-07). With each deleted after use, 70,000 names created none
 *     failed, so the bound is on facets kept, not names ever used. Local
 *     workerd differs: its facet index allows 65,535 names over the
 *     object's lifetime (facet-tree-index.c++).
 *
 * A failed reclaim stays loud (facet-spawn's `runOnceAndReclaim`): storage
 * that was not given back is a permanent charge against the root's quota,
 * and swallowing that is how the original leak stayed invisible.
 *
 * The pool drives the RAW `ctx.facets` container and assumes it is the only
 * thing naming facets on this actor. The Agents SDK's sub-agent layer makes
 * the same assumption from the other side — it owns facet naming and runs
 * its own cleanup — so the two are mutually exclusive on one actor:
 * whichever acts second aborts or retires facets the other still tracks.
 */
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
/** `ctx.facets`, as the pool drives it — same surface the facet host uses. */
export interface FacetPoolContainer {
    get(name: string, start: () => Promise<{
        class: unknown;
    }>): unknown;
    abort(name: string, reason?: unknown): void;
    delete(name: string): void;
}
/** The hosting actor's context: its facet container, and its storage. */
export interface FacetPoolContext {
    facets?: FacetPoolContainer;
    storage: {
        /** The session's SQL, where the storage ledger (N18) records facet databases. */
        sql?: SqlDatabase;
    };
}
/**
 * One leased facet. Dispose (or `retire()`) evicts the instance and WIPES
 * its storage; `detach()` first to keep the storage — after it, disposal
 * only evicts. The stub is coordinator-local: do not store it past the turn
 * or hand it to anything else.
 */
export interface FacetLease<S> {
    readonly name: string;
    readonly stub: S;
    /** Keep the facet's storage: disposal becomes eviction only. */
    detach(): void;
    /** Idempotent. Throws, loudly, when the platform refuses the wipe. */
    retire(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}
/** The facet pool of one hosting actor. Cheap accessor, like `timers()`. */
export declare function facetPool(ctx: FacetPoolContext): FacetPool;
export declare class FacetPool {
    private readonly ctx;
    constructor(ctx: FacetPoolContext);
    /** Open (or re-enter) the named facet under a lease. */
    acquire<S = unknown>(name: string, start: () => Promise<{
        class: unknown;
    }>): Promise<FacetLease<S>>;
}
//# sourceMappingURL=facet-pool.d.ts.map