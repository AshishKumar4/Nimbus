/**
 * budgets.ts — per-DO accounting for the platform budgets the fabric spends:
 * the Durable Object's Dynamic Worker concurrency limit, the facet-ID
 * lifetime budget, and the dynamic-worker module-map ceiling.
 *
 * The Dynamic Worker model is Cloudflare's documented one
 * ({@link DO_DYNAMIC_WORKER_LIMIT}): a Durable Object may have a fixed number
 * of DISTINCT Dynamic Workers with in-flight requests at once, shared across
 * every concurrent request to that object (one I/O context), and any number
 * of in-flight requests to the same Dynamic Worker count as one. Only
 * in-flight requests count: a loader id with nothing in flight holds nothing.
 *
 * The ledger counts, per hosting actor, the distinct workers that are in
 * flight right now, keyed by loader id (a fresh key per unkeyed `load`), plus
 * the width fan-outs have claimed and not yet released. A fan-out spends only
 * the {@link dynamicWorkerHeadroom} that leaves, so work a Durable Object
 * already has in flight — a resident process, the esbuild facet, a git
 * network op, another fan-out — keeps its slots. Work that would rather wait
 * than be refused waits on the ledger ({@link beginLoaderFetchWhenFree}) and
 * is let in, in the order it asked, by whichever release makes room.
 *
 * Keyed weakly off the hosting actor's `ctx`, like the facet slot books: the
 * limit is per Durable Object, and dynamic workers die with the isolate that
 * loaded them, so a ledger that goes away with its host describes nothing
 * that still exists.
 */
/**
 * Distinct Dynamic Workers one Durable Object may have with in-flight
 * requests at once, shared across all concurrent requests to that object;
 * multiple in-flight requests to one Dynamic Worker count once.
 * https://developers.cloudflare.com/changelog/post/2026-08-28-durable-objects-dynamic-workers-limit/
 */
export declare const DO_DYNAMIC_WORKER_LIMIT = 10;
/**
 * Ends one hold, idempotently. Pass the error the call failed with, if it
 * did: a "Dynamic worker concurrency limit exceeded" refusal pauses the
 * ledger's admissions (see {@link beginLoaderFetchWhenFree}); anything else,
 * or nothing, just ends the hold.
 */
export type EndLoaderFetch = (failure?: unknown) => void;
/**
 * A width one fan-out reserved with {@link claimDynamicWorkers}. Holds taken
 * under it (`beginLoaderFetch(ctx, key, claim)`) count inside that width, not
 * on top of it, until `release` (idempotent).
 */
export interface DynamicWorkerClaim {
    release(): void;
}
/**
 * Hold the Dynamic Worker `workerKey` in flight on this actor's ledger; the
 * returned function ends the hold (idempotently), from the caller's own
 * `finally`. Holds on one key nest: the worker counts once until the last
 * one ends, as the platform counts it. Under a `claim`, the hold counts
 * inside the claim's width. This never waits: it is for work the actor
 * starts regardless (a resident process); {@link beginLoaderFetchWhenFree}
 * waits for room.
 *
 * A begin/end pair rather than a wrapper on purpose, and the shape is
 * load-bearing: wrapping the stub call in a ledger-owned async frame
 * (`trackLoaderFetch(ctx, () => entrypoint.execute(...))`) left the hosting
 * Durable Object poisoned after every pooled dispatch — the next fabric
 * activity hung the object or reset the instance outright (pid base jumped,
 * every attached WebSocket dropped with no close frame), measured 7/7 on
 * staging and gone 3/3 with the direct call restored. Same seam-quirk class
 * as pipelined `fetch.call`, which workerd refuses for dynamically-loaded
 * workers: an RPC stub call must stay a direct property call awaited by the
 * frame that made it, so the ledger only brackets it.
 */
export declare function beginLoaderFetch(ctx: object, workerKey: string, claim?: DynamicWorkerClaim): EndLoaderFetch;
/**
 * {@link beginLoaderFetch} once the ledger has room: resolves, holding
 * `workerKey`, as soon as that worker is already in flight (holds on it
 * count once) or a distinct worker more fits — within the `claim`'s width,
 * or the actor's headroom. Waits are let in in the order they asked, by
 * whoever's release makes the room: a hold's end, a claim's release, a
 * pause's end. The hold is taken as the wait is let in, so a freed slot
 * wakes one waiter and no other caller can take it first; once resolved, it
 * is the caller's to end.
 *
 * A call refused with "Dynamic worker concurrency limit exceeded" ends its
 * hold with the refusal (`end(error)`) and waits again: the refusal pauses
 * admission (50 ms, doubling to 2 s while refusals continue), because the
 * platform counts a worker for a moment after its call returns and no
 * release can show that.
 *
 * `signal` abandons the wait: it rejects with the signal's reason and holds
 * nothing. A wait outlives nothing on its own: bound it with a signal when
 * room may never come (a resident process holds its worker for as long as
 * it runs).
 *
 *   const end = await beginLoaderFetchWhenFree(ctx, key, { signal });
 *   try { return await worker.getEntrypoint().run(); }
 *   catch (error) { end(error); throw error; }
 *   finally { end(); }
 */
export declare function beginLoaderFetchWhenFree(ctx: object, workerKey: string, options?: {
    signal?: AbortSignal;
    claim?: DynamicWorkerClaim;
}): Promise<EndLoaderFetch>;
/**
 * Distinct Dynamic Workers this actor may still put in flight: the limit
 * less what is held and claimed right now, and none while a limit refusal's
 * pause lasts. Never negative.
 */
export declare function dynamicWorkerHeadroom(ctx: object): number;
/**
 * Claim `width` distinct Dynamic Workers for one fan-out, or null when the
 * headroom cannot hold it. The claim counts until `release` (idempotent), so
 * a second fan-out sizing itself meanwhile sees it; the claimant's own
 * dispatches, held under the claim, count inside it.
 */
export declare function claimDynamicWorkers(ctx: object, width: number): DynamicWorkerClaim | null;
/** Snapshot for the diag surface. Pure read; no I/O. */
export declare function loaderLedgerStats(ctx: object): {
    limit: number;
    inFlightWorkers: string[];
    claimed: number;
    headroom: number;
    peak: number;
    /** Waits not yet admitted. */
    waiting: number;
    /** Length of the pause a limit refusal started, while it lasts; 0 when admitting. */
    pauseMs: number;
};
/**
 * Name the per-DO accounting on a "Dynamic worker concurrency limit exceeded"
 * failure; hand every other error back untouched. The platform's message
 * says only that the limit was hit — which workers were in flight, and what
 * fan-outs had claimed, is what the operator needs to know to shrink anything.
 */
export declare function withDynamicWorkerCapNamed<E>(ctx: object, error: E): E | Error;
/**
 * Total bytes a dynamic Worker's module map may carry, across every member of
 * it. A hard platform limit, not a policy knob: 62 MiB lands and 64 MiB is
 * refused with "Dynamic Worker code size (N bytes) exceeds the maximum allowed
 * size of 67108864 bytes", confirmed at five sizes with two trials each. The
 * budget is shared, so a ruby process is already 34.3 MiB down before its disk
 * is counted.
 */
export declare const DYNAMIC_WORKER_CODE_LIMIT_BYTES = 67108864;
/**
 * Refuse a module map over {@link DYNAMIC_WORKER_CODE_LIMIT_BYTES}, naming
 * the largest members. The platform's own refusal reports one number for a
 * budget shared across every member of the map, which tells the operator
 * nothing about WHAT to shrink — so every fabric seam that assembles a map
 * runs this before the loader sees it.
 *
 * Costed to its two paths. Under the ceiling: one length read per member —
 * UTF-16 code units for text, which equal UTF-8 bytes for the ASCII module
 * text the generators emit and undercount otherwise; the platform's own
 * refusal still backstops the exotic case, because this check exists to name
 * members, not to be the ceiling. Over it: exact UTF-8 sizes, computed only
 * then, sorted so the biggest lever is first.
 */
export declare function assertModuleMapWithinCodeLimit(modules: Record<string, unknown>): void;
/**
 * Facet IDs a Durable Object is granted over its LIFETIME. Append-only and
 * never reclaimed, so crossing it is unrecoverable for the object — which is
 * why the ledger below counts consumption durably instead of leaving the
 * bound as prose the slot book merely respects.
 */
export declare const FACET_ID_LIFETIME_BUDGET = 65536;
/** Where the ledger persists the count of facet names ever minted. */
export declare const FACET_NAME_HIGH_WATER_KEY = "fabric_facet_name_high_water";
/** The slice of storage the facet-name ledger persists through. */
interface FacetNameLedgerStorage {
    storage: {
        get(key: string): Promise<unknown> | unknown;
        put(key: string, value: unknown): Promise<void>;
    };
}
/**
 * Advance the durable ledger to this incarnation's name count, if it is a new
 * lifetime high. Chained behind adoption so the comparison is always against
 * the real persisted value; a failed write leaves the old link's count and the
 * next mint tries again — the ledger may transiently undercount, never over.
 */
export declare function recordFacetNameMinted(ctx: FacetNameLedgerStorage, count: number): void;
/** The best count available without awaiting storage: minted or adopted. */
export declare function facetNameCount(ctx: FacetNameLedgerStorage): number;
/** The count with adoption awaited, for a first failure on a fresh boot. */
export declare function facetNameCountDurable(ctx: FacetNameLedgerStorage): Promise<number>;
/**
 * The lifetime facet-ID ledger: how many facet names this fabric has ever
 * minted on the Durable Object, against the 65,536 the platform will ever
 * grant it. `consumed` only ever counts FIRST uses — a reused name, in this
 * incarnation or any earlier one, cost no new ID, which is the slot book's
 * whole reason to exist. Surfaced so an operator can see proximity to a wall
 * whose crossing is unrecoverable, instead of discovering it from the
 * platform's opaque failure.
 */
export declare function facetIdBudget(ctx: FacetNameLedgerStorage): Promise<{
    consumed: number;
    budget: number;
}>;
/**
 * Name the facet-ID budget on a creation failure at the wall; below it, hand
 * the error back untouched. Exhaustion is the one failure here the platform
 * reports opaquely AND that no teardown, retry or reset can undo, so the
 * ledger — the only witness to the real cause — does the naming. Not a
 * threshold: the comparison is against the budget itself.
 */
export declare function withFacetBudgetNamed(consumed: number, error: unknown): unknown;
export {};
//# sourceMappingURL=budgets.d.ts.map