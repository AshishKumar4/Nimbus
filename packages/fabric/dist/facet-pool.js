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
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { forgetFacetStorage } from '@nimbus-sh/core/runtime/storage-ledger.js';
/** The facet pool of one hosting actor. Cheap accessor, like `timers()`. */
export function facetPool(ctx) {
    return new FacetPool(ctx);
}
export class FacetPool {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    /** Open (or re-enter) the named facet under a lease. */
    async acquire(name, start) {
        const facets = this.ctx.facets;
        if (!facets || typeof facets.get !== 'function') {
            throw new Error('fabric: ctx.facets is unavailable in this Durable Object; facets cannot be leased');
        }
        const stub = facets.get(name, start);
        let settled = false;
        let keepStorage = false;
        const retire = async () => {
            if (settled)
                return;
            settled = true;
            // Evict first so the wipe never lands under a live writer; a facet
            // already gone makes the abort a no-op.
            try {
                facets.abort(name, new Error('fabric: facet lease retired'));
            }
            catch { /* already gone */ }
            if (keepStorage)
                return;
            try {
                facets.delete(name);
                if (this.ctx.storage.sql)
                    forgetFacetStorage(this.ctx.storage.sql, name);
            }
            catch (e) {
                throw new Error(`fabric: facet '${name}' was evicted but its storage was not reclaimed — `
                    + `it is leaked into the root Durable Object's shared quota: ${errorText(e)}`, { cause: e });
            }
        };
        return {
            name,
            stub,
            detach() { keepStorage = true; },
            retire,
            [Symbol.asyncDispose]: retire,
        };
    }
}
