#!/usr/bin/env bun
// The facet lease. Proteus's facet-spawn.ts exists because the platform's two
// verbs are indistinguishable to a caller — abort keeps storage, delete wipes
// it — and confusing them "is the leak this module previously had, in which
// every head and every MCTS branch abandoned a permanent database inside the
// orchestrator DO". A facet's storage is charged to the ROOT, the overflow is
// an uncatchable reset, and the second wall is 65,536 facet ids per DO
// lifetime — so the DEFAULT disposal path must reclaim, and keeping storage
// must be the explicit opt-in (detach, today's abort).

import assert from 'node:assert/strict';
import { facetPool } from '../../packages/fabric/src/facet-pool.ts';
import {
  FACET_ID_LIFETIME_BUDGET,
  recordFacetNameMinted,
  facetNameCount,
} from '../../packages/fabric/src/budgets.ts';

/** The platform seam: a ctx.facets that records which verb touched which
 *  facet, and models the storage consequence of each. */
function createHost({ failDelete = false } = {}) {
  const verbs = [];
  const storage = new Map(); // name -> 'live' | 'kept' | 'wiped'
  const kv = new Map();
  return {
    verbs,
    facetStorage: storage,
    ctx: {
      storage: {
        async get(key) { return kv.get(key); },
        async put(key, value) { kv.set(key, value); },
      },
      facets: {
        get(name, start) {
          verbs.push(['get', name]);
          storage.set(name, 'live');
          return { facetName: name, start };
        },
        abort(name, reason) {
          verbs.push(['abort', name, reason instanceof Error ? reason.message : reason]);
          if (storage.get(name) === 'live') storage.set(name, 'kept');
        },
        delete(name) {
          if (failDelete) throw new Error('facet index busy');
          verbs.push(['delete', name]);
          storage.set(name, 'wiped');
        },
      },
    },
  };
}

const start = async () => ({ class: {} });

// ── 1. The default disposal path reclaims storage ────────────────────────────

{
  const host = createHost();
  {
    await using branch = await facetPool(host.ctx).acquire('branch-1', start);
    assert.equal(branch.name, 'branch-1');
    assert.equal(branch.stub.facetName, 'branch-1', 'the lease exposes the platform stub');
  }
  assert.equal(host.facetStorage.get('branch-1'), 'wiped',
    'dispose retires: the storage the leak abandoned is reclaimed');
  const kinds = host.verbs.map(([v]) => v);
  assert.deepEqual(kinds, ['get', 'abort', 'delete'], 'evict first, then wipe — never a live writer');
}

// ── 2. Disposal still reclaims when the body throws ──────────────────────────

{
  const host = createHost();
  const body = async () => {
    await using branch = await facetPool(host.ctx).acquire('branch-2', start);
    void branch;
    throw new Error('exploration failed');
  };
  await assert.rejects(body, /exploration failed/, 'the body error is not masked by the reclaim');
  assert.equal(host.facetStorage.get('branch-2'), 'wiped',
    'a throwing body must not abandon a database inside the root DO');
}

// ── 3. detach keeps storage: disposal becomes today's abort ─────────────────

{
  const host = createHost();
  {
    await using branch = await facetPool(host.ctx).acquire('branch-3', start);
    branch.detach();
  }
  assert.equal(host.facetStorage.get('branch-3'), 'kept', 'detach opts into keep-storage');
  assert.ok(!host.verbs.some(([v]) => v === 'delete'), 'a detached lease never deletes');
}

// ── 4. Disposal is idempotent ────────────────────────────────────────────────

{
  const host = createHost();
  const lease = await facetPool(host.ctx).acquire('branch-4', start);
  await lease.retire();
  await lease.retire();
  assert.equal(host.verbs.filter(([v]) => v === 'delete').length, 1);
}

// ── 5. A failed reclaim is loud — the quota leak is named, never swallowed ──

{
  const host = createHost({ failDelete: true });
  const lease = await facetPool(host.ctx).acquire('branch-5', start);
  await assert.rejects(
    () => lease.retire(),
    (e) => /branch-5/.test(e.message) && /quota/.test(e.message) && e.cause instanceof Error,
  );
}

// ── 6. The 65,536-id lifetime wall: refused by the ledger, by name ───────────

{
  const host = createHost();
  const pool = facetPool(host.ctx);
  const first = await pool.acquire('head-1', start);
  assert.equal(facetNameCount(host.ctx), 1, 'a first-use name consumes one lifetime id');
  await pool.acquire('head-1', start).then((lease) => lease.detach());
  assert.equal(facetNameCount(host.ctx), 1, 'a reused name costs no new id');
  await first.retire();

  // The object has spent its lifetime budget.
  recordFacetNameMinted(host.ctx, FACET_ID_LIFETIME_BUDGET);
  await assert.rejects(
    () => pool.acquire('head-new', start),
    (e) => /65,536/.test(e.message) && /lifetime budget/.test(e.message),
    'a new name at the wall is refused with the ledger naming the cause',
  );
  // A name this object already minted costs nothing and still works.
  const reused = await pool.acquire('head-1', start);
  await reused.retire();
}

console.log('ok - fabric-facet-pool (retire reclaims, throw-safe, detach keeps, loud leak, id budget)');
