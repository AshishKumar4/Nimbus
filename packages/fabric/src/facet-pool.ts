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
 *   - 65,536 facet ids per DO lifetime (`do.facet.count`), append-only and
 *     never reclaimed — the binding constraint for the leak, reached an
 *     order of magnitude before the byte quota. The pool counts first-use
 *     names in the durable ledger (budgets.ts) and refuses a NEW name at the
 *     wall by name, instead of letting the platform fail opaquely. Refusal
 *     at the wall is exact, not a threshold: the ledger never overcounts.
 *
 * A failed reclaim stays loud (facet-spawn's `runOnceAndReclaim`): storage
 * that was not given back is a permanent charge against the root's quota,
 * and swallowing that is how the original leak stayed invisible.
 *
 * The pool drives the RAW `ctx.facets` container and assumes it is the only
 * thing naming facets on this actor. The Agents SDK's sub-agent layer makes
 * the same assumption from the other side — it owns facet naming and runs
 * its own cleanup — so the two are mutually exclusive on one actor:
 * whichever acts second aborts or retires facets the other still tracks,
 * and the facet-id ledger here counts only the names this pool minted.
 */

import {
  FACET_ID_LIFETIME_BUDGET,
  facetNameCount,
  recordFacetNameMinted,
  withFacetBudgetNamed,
} from './budgets.js';

/** `ctx.facets`, as the pool drives it — same surface the facet host uses. */
export interface FacetPoolContainer {
  get(name: string, start: () => Promise<{ class: unknown }>): unknown;
  abort(name: string, reason?: unknown): void;
  delete(name: string): void;
}

/** The hosting actor's context: its facet container, and the storage the
 *  facet-id ledger persists through. */
export interface FacetPoolContext {
  facets?: FacetPoolContainer;
  storage: {
    get(key: string): Promise<unknown> | unknown;
    put(key: string, value: unknown): Promise<void>;
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

/** Names this ctx's pool has already charged to the lifetime ledger. */
const chargedNames = new WeakMap<object, Set<string>>();

/** The facet pool of one hosting actor. Cheap accessor, like `timers()`. */
export function facetPool(ctx: FacetPoolContext): FacetPool {
  return new FacetPool(ctx);
}

export class FacetPool {
  constructor(private readonly ctx: FacetPoolContext) {}

  /**
   * Open (or re-enter) the named facet under a lease. A first-use name
   * consumes one of the object's 65,536 lifetime facet ids and is refused at
   * the wall; a reused name costs nothing, in this incarnation or any other.
   */
  async acquire<S = unknown>(
    name: string,
    start: () => Promise<{ class: unknown }>,
  ): Promise<FacetLease<S>> {
    const facets = this.ctx.facets;
    if (!facets || typeof facets.get !== 'function') {
      throw new Error('fabric: ctx.facets is unavailable in this Durable Object; facets cannot be leased');
    }
    let charged = chargedNames.get(this.ctx);
    if (!charged) {
      charged = new Set();
      chargedNames.set(this.ctx, charged);
    }
    if (!charged.has(name)) {
      const consumed = facetNameCount(this.ctx);
      if (consumed >= FACET_ID_LIFETIME_BUDGET) {
        throw withFacetBudgetNamed(
          consumed,
          new Error(`facet '${name}' refused before creation: no lifetime ids remain`),
        );
      }
      recordFacetNameMinted(this.ctx, consumed + 1);
      charged.add(name);
    }
    const stub = facets.get(name, start) as S;
    let settled = false;
    let keepStorage = false;
    const retire = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      // Evict first so the wipe never lands under a live writer; a facet
      // already gone makes the abort a no-op.
      try { facets.abort(name, new Error('fabric: facet lease retired')); } catch { /* already gone */ }
      if (keepStorage) return;
      try {
        facets.delete(name);
      } catch (e) {
        throw new Error(
          `fabric: facet '${name}' was evicted but its storage was not reclaimed — `
            + `it is leaked into the root Durable Object's shared quota: ${errorText(e)}`,
          { cause: e },
        );
      }
    };
    return {
      name,
      stub,
      detach(): void { keepStorage = true; },
      retire,
      [Symbol.asyncDispose]: retire,
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
