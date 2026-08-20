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
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';
const ledgers = new WeakMap();
function ledger(ctx) {
    let entry = ledgers.get(ctx);
    if (!entry) {
        entry = { ids: new Set(), liveFetches: 0, peakLiveFetches: 0 };
        ledgers.set(ctx, entry);
    }
    return entry;
}
/** Record a keyed `loader.get(id)` — a permanent slot if the id is new. */
export function recordLoaderId(ctx, id) {
    ledger(ctx).ids.add(id);
}
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
export function beginLoaderFetch(ctx) {
    const entry = ledger(ctx);
    entry.liveFetches++;
    entry.peakLiveFetches = Math.max(entry.peakLiveFetches, entry.liveFetches);
    let ended = false;
    return () => {
        if (ended)
            return;
        ended = true;
        entry.liveFetches--;
    };
}
/** Snapshot for the diag surface. Pure read; no I/O. */
export function loaderLedgerStats(ctx) {
    const entry = ledger(ctx);
    return {
        idsEverGotten: [...entry.ids],
        liveFetches: entry.liveFetches,
        peakLiveFetches: entry.peakLiveFetches,
    };
}
/**
 * Name the per-DO accounting on a "Too many concurrent dynamic workers"
 * failure; hand every other error back untouched. The platform's message
 * says only that the cap was hit — which ids hold the slots, and that a
 * keyed id can never give one back, is what the operator needs to know to
 * shrink anything.
 */
export function withDynamicWorkerCapNamed(ctx, error) {
    if (classifyError(error) !== 'dynamic_worker_cap')
        return error;
    const entry = ledger(ctx);
    const platform = error instanceof Error ? error.message : String(error);
    return new Error(`${platform} — this Durable Object has ${entry.ids.size} loader id(s) permanently `
        + `holding dynamic-worker slots (a loader.get id is never released): `
        + `${[...entry.ids].join(', ') || '(none recorded)'}; live Loader fetches ${entry.liveFetches}, `
        + `peak ${entry.peakLiveFetches}`, { cause: error });
}
