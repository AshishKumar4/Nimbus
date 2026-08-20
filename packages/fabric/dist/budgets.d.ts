/**
 * budgets.ts — per-DO accounting for the platform budgets the fabric spends:
 * the Worker Loader's two caps, the facet-ID lifetime budget, and the
 * dynamic-worker module-map ceiling.
 *
 * Measured on production workerd: a Durable Object admits ~5–6 concurrent
 * dynamic workers before the platform refuses with "Too many concurrent
 * dynamic workers", one DO method can drive at most 4 concurrent Loader
 * fetches, and loader-cache entries are never released — every DISTINCT
 * `loader.get(id)` permanently consumes one of the dynamic-worker slots for
 * the object's lifetime. Nimbus stays under the caps by construction
 * (`IN_DO_THRESHOLD` = 5 in the fanout pool), which until now meant the slots
 * were counted in prose. This ledger counts them at the fabric's loader call
 * sites instead — the loader pool's slots, a resident process's keyed worker,
 * a one-shot's load — so proximity is measurable and a cap failure can name
 * the ids actually holding slots.
 *
 * Measurement only: no admission control. The caps are the platform's, they
 * are approximate ("~5–6"), and a gate on an approximate number would refuse
 * work the platform would have run.
 *
 * Keyed weakly off the hosting actor's `ctx`, like the facet slot books: the
 * caps are per Durable Object, and dynamic workers die with the isolate that
 * loaded them, so a ledger that goes away with its host describes nothing
 * that still exists.
 */
/** Record a keyed `loader.get(id)` — a permanent slot if the id is new. */
export declare function recordLoaderId(ctx: object, id: string): void;
/**
 * Count one call into a dynamic worker as a live Loader fetch; the returned
 * function ends it (idempotently), from the caller's own `finally`.
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
export declare function beginLoaderFetch(ctx: object): () => void;
/** Snapshot for the diag surface. Pure read; no I/O. */
export declare function loaderLedgerStats(ctx: object): {
    idsEverGotten: string[];
    liveFetches: number;
    peakLiveFetches: number;
};
/**
 * Name the per-DO accounting on a "Too many concurrent dynamic workers"
 * failure; hand every other error back untouched. The platform's message
 * says only that the cap was hit — which ids hold the slots, and that a
 * keyed id can never give one back, is what the operator needs to know to
 * shrink anything.
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