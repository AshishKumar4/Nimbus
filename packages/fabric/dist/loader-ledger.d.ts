/**
 * loader-ledger.ts — per-DO accounting for the Worker Loader's two caps.
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
/** Run one call into a dynamic worker, counted as a live Loader fetch. */
export declare function trackLoaderFetch<T>(ctx: object, run: () => Promise<T>): Promise<T>;
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
//# sourceMappingURL=loader-ledger.d.ts.map