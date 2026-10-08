#!/usr/bin/env bun
// The facet lease. Proteus's facet-spawn.ts exists because the platform's two
// verbs are indistinguishable to a caller — abort keeps storage, delete wipes
// it — and confusing them "is the leak this module previously had, in which
// every head and every MCTS branch abandoned a permanent database inside the
// orchestrator DO". A facet's storage is charged to the ROOT, the overflow is
// an uncatchable reset, and live facets are bounded too — so the DEFAULT
// disposal path must reclaim, and keeping storage must be the explicit
// opt-in (detach, today's abort).

import assert from 'node:assert/strict';
import { facetPool } from '../../packages/fabric/src/facet-pool.ts';

/** The platform seam: a ctx.facets that records which verb touched which
 *  facet, and models the storage consequence of each. */
function createHost({ failDelete = false, kv = new Map() } = {}) {
  const verbs = [];
  const storage = new Map(); // name -> 'live' | 'kept' | 'wiped'
  return {
    verbs,
    facetStorage: storage,
    ctx: {
      // The actor's own storage, as DO storage's get and put reach it.
      storage: {
        async get(key) { return kv.get(key); },
        async put(keyOrEntries, value) {
          const entries = typeof keyOrEntries === 'string' ? { [keyOrEntries]: value } : keyOrEntries;
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

// ── 6. Names are not rationed ───────────────────────────────────────────────
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

console.log('ok - fabric-facet-pool (retire reclaims, throw-safe, detach keeps, loud leak, names not rationed)');
