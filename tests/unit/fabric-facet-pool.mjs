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
  FACET_NAME_HIGH_WATER_KEY,
  facetNameCount,
} from '../../packages/fabric/src/budgets.ts';

/** The platform seam: a ctx.facets that records which verb touched which
 *  facet, and models the storage consequence of each. */
function createHost({ failDelete = false, namesMinted, kv = new Map(), failPut = () => false, failGet = () => false } = {}) {
  const verbs = [];
  const storage = new Map(); // name -> 'live' | 'kept' | 'wiped'
  if (namesMinted !== undefined) kv.set(FACET_NAME_HIGH_WATER_KEY, namesMinted);
  return {
    verbs,
    facetStorage: storage,
    kv,
    ctx: {
      storage: {
        // DO storage's get may answer synchronously, and so may its failure.
        get(key) {
          if (failGet(key)) throw new Error(`storage read of ${key} failed`);
          return Promise.resolve(kv.get(key));
        },
        // Both of DO storage's forms; a multi-key put is one atomic write.
        async put(keyOrEntries, value) {
          const entries = typeof keyOrEntries === 'string' ? { [keyOrEntries]: value } : keyOrEntries;
          if (failPut(Object.keys(entries))) throw new Error(`storage write of ${Object.keys(entries)} failed`);
          for (const [key, entry] of Object.entries(entries)) kv.set(key, entry);
        },
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
  // One lifetime id left.
  const host = createHost({ namesMinted: FACET_ID_LIFETIME_BUDGET - 1 });
  const pool = facetPool(host.ctx);
  const first = await pool.acquire('head-1', start);
  assert.equal(facetNameCount(host.ctx), FACET_ID_LIFETIME_BUDGET, 'a first-use name consumes one lifetime id');
  await pool.acquire('head-1', start).then((lease) => lease.detach());
  assert.equal(facetNameCount(host.ctx), FACET_ID_LIFETIME_BUDGET, 'a reused name costs no new id');
  await first.retire();

  // The object has spent its lifetime budget.
  await assert.rejects(
    () => pool.acquire('head-new', start),
    (e) => /65,536/.test(e.message) && /lifetime budget/.test(e.message),
    'a new name at the wall is refused with the ledger naming the cause',
  );
  // A name this object already minted costs nothing and still works.
  const reused = await pool.acquire('head-1', start);
  await reused.retire();
}

// ── 7. A charge that is not durable fails, and creates nothing ──────────────
// The write of head-1's charge fails, so its lease is refused before the
// facet exists. After a reset, a different name is the only id consumed.

{
  const kv = new Map();
  let failing = true;
  const first = createHost({ kv, failPut: () => failing });
  await assert.rejects(() => facetPool(first.ctx).acquire('head-1', start), /storage write/);
  assert.ok(!first.verbs.some(([verb, name]) => verb === 'get' && name === 'head-1'), 'no facet without a durable charge');
  failing = false;
  const second = createHost({ kv });
  await facetPool(second.ctx).acquire('head-2', start).then((lease) => lease.detach());
  assert.equal(kv.get(FACET_NAME_HIGH_WATER_KEY), 1, 'head-2 is the one id consumed');
}

// ── 8. A failed read of a name's mark fails its charge, never recounts it ────
// head-1 is minted and counted. After a reset, the read of its mark fails
// (at once, as DO storage's get can): that charge fails and writes nothing,
// and the next one finds the mark.

{
  const kv = new Map();
  const first = createHost({ kv });
  await facetPool(first.ctx).acquire('head-1', start).then((lease) => lease.detach());
  assert.equal(kv.get(FACET_NAME_HIGH_WATER_KEY), 1);
  let failures = 1;
  const second = createHost({ kv, failGet: (key) => key.includes('head-1') && failures-- > 0 });
  const pool = facetPool(second.ctx);
  await assert.rejects(() => pool.acquire('head-1', start), /storage read/);
  assert.equal(kv.get(FACET_NAME_HIGH_WATER_KEY), 1, 'a read that failed charges nothing');
  await pool.acquire('head-1', start).then((lease) => lease.detach());
  assert.equal(kv.get(FACET_NAME_HIGH_WATER_KEY), 1, 'head-1 is still one id');
}

// ── 9. A failed read of the count fails the charge; the next one adopts it ──
// Five ids are spent. The read of that count fails once: a charge made then
// is refused, never counted from zero.

{
  const kv = new Map([[FACET_NAME_HIGH_WATER_KEY, 5]]);
  let failures = 1;
  const host = createHost({ kv, failGet: (key) => key === FACET_NAME_HIGH_WATER_KEY && failures-- > 0 });
  const pool = facetPool(host.ctx);
  await assert.rejects(() => pool.acquire('head-1', start), /storage read/);
  assert.equal(kv.get(FACET_NAME_HIGH_WATER_KEY), 5, 'nothing is written from a count never read');
  await pool.acquire('head-1', start).then((lease) => lease.detach());
  assert.equal(kv.get(FACET_NAME_HIGH_WATER_KEY), 6);
}

// ── 10. Names are not rationed ──────────────────────────────────────────────
// Cloudflare bounds facets kept, not names used: one object created 70,000
// names, deleting each after use, and none failed (2026-10-07). An object
// whose storage holds an earlier release's count of names at 65,536 still
// leases a new one, and those rows are left as they are.

{
  const kv = new Map([['fabric_facet_name_high_water', 65_536], ['fabric_facet_slot_high_water', 65_536]]);
  const host = createHost({ kv });
  const lease = await facetPool(host.ctx).acquire('head-65537', start);
  await lease.retire();
  assert.equal(host.facetStorage.get('head-65537'), 'wiped');
  assert.deepEqual([...kv], [['fabric_facet_name_high_water', 65_536], ['fabric_facet_slot_high_water', 65_536]],
    'the earlier rows are not read into a refusal, and not rewritten');
}

console.log('ok - fabric-facet-pool (retire reclaims, throw-safe, detach keeps, loud leak, id budget)');
