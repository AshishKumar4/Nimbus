#!/usr/bin/env bun
// The 65,536 facet-ID lifetime budget, counted instead of prosed about.
//
// A Durable Object admits 65,536 facet IDs over its LIFETIME; the IDs are
// append-only and never reclaimed. Each process of an incarnation takes a
// name no earlier process of it held (residentFacetName), so every spawn
// spends one; the exhaustion failure is unrecoverable for the DO while the
// platform's message for it names nothing. What has to hold:
//
//   (1) the ledger counts names ever minted: one per process of an
//       incarnation, and none for a name reused after a reset;
//   (2) the count is durable: a fresh incarnation adopts the persisted
//       high-water instead of restarting it, and never writes a smaller one;
//   (3) a creation failure AT the wall names the budget and the count, and a
//       failure below the wall keeps the error it actually had.
//
// Behavior is asserted through the public fabric surface only.

import assert from 'node:assert/strict';
import { ProcessFabric } from '../../packages/fabric/src/process-fabric.ts';
import {
  FACET_ID_LIFETIME_BUDGET,
  FACET_NAME_HIGH_WATER_KEY,
  facetIdBudget,
} from '../../packages/fabric/src/budgets.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { facetPool } from '../../packages/fabric/src/facet-pool.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import {
  createCtxExports,
  createFacetCtx,
  createFacetWorld,
} from './facet-host-harness.mjs';

adoptCtxExports(createCtxExports(() => { throw new Error('no disk'); }));

const BOOT = {
  kind: 'code',
  code: {
    compatibilityDate: '2025-01-01',
    compatibilityFlags: [],
    mainModule: 'worker.js',
    modules: { 'worker.js': 'export default {}' },
  },
};

/** A fabric over its own world and ctx, so the test can read the ledger. */
function setup({ doId = 'ledger-do', storage = new Map(), evaluate } = {}) {
  const world = createFacetWorld(evaluate ?? (() => ({
    startProcess: () => Promise.resolve({ ok: true }),
    handleHttpRequest: () => Promise.resolve(new Response('ok')),
  })));
  const ctx = createFacetCtx(world, doId, storage);
  const env = { LOADER: world.loader };
  const fabric = new ProcessFabric(processHostFor(ctx, env, () => ({
    readFile() { throw new Error('no disk'); },
  })));
  return { world, ctx, storage, fabric };
}

function spawn(fabric, pid) {
  return fabric.startResidentProcess({
    startContract: 'boot',
    pid,
    workerKey: `nimbus-process:ledger-do:${pid}`,
    boot: BOOT,
    onWriterActivated() {},
    onWriterRetired() {},
  });
}

// ── (1) names minted are counted, one per process ────────────────────────────
{
  const { ctx, fabric } = setup();
  const a = await spawn(fabric, 1);
  const b = await spawn(fabric, 2);
  const c = await spawn(fabric, 3);
  await Promise.all([a.booted(), b.booted(), c.booted()]);
  assert.deepEqual(
    await facetIdBudget(ctx),
    { consumed: 3, budget: FACET_ID_LIFETIME_BUDGET },
    'three concurrent processes mint three names',
  );

  // Release one and spawn again: the next process takes a fourth name.
  c.kill();
  await c.done;
  const d = await spawn(fabric, 4);
  await d.booted();
  assert.equal(
    (await facetIdBudget(ctx)).consumed, 4,
    'a spawn after a release takes a name of its own',
  );
  for (const handle of [a, b, d]) { handle.kill(); await handle.done; }
}

// ── (2) the count is durable, and a fresh incarnation adopts it ─────────────
{
  const storage = new Map();
  const first = setup({ storage });
  const p1 = await spawn(first.fabric, 1);
  const p2 = await spawn(first.fabric, 2);
  await Promise.all([p1.booted(), p2.booted()]);
  assert.equal((await facetIdBudget(first.ctx)).consumed, 2);
  p1.kill(); p2.kill();
  await Promise.all([p1.done, p2.done]);

  // A reset: a new instance over the rows the old one left behind. Its slot
  // book restarts at zero — the same names come back, so nothing new is
  // minted, and the persisted high-water must not be clobbered downward.
  const second = setup({ storage });
  const p3 = await spawn(second.fabric, 11);
  await p3.booted();
  assert.equal(
    (await facetIdBudget(second.ctx)).consumed, 2,
    'a fresh incarnation adopts the persisted count; reusing a name after a reset does not increment it',
  );
  assert.equal(storage.get(FACET_NAME_HIGH_WATER_KEY), 2, 'the durable row holds the high-water');
  p3.kill();
  await p3.done;
}

// ── (3) a creation failure AT the wall names the budget ─────────────────────
{
  const storage = new Map([[FACET_NAME_HIGH_WATER_KEY, FACET_ID_LIFETIME_BUDGET]]);
  const { fabric } = setup({
    storage,
    // The platform's failure at exhaustion is opaque; the fabric's ledger is
    // what has to name the real cause.
    evaluate: () => { throw new Error('internal error'); },
  });
  const handle = await spawn(fabric, 1);
  await assert.rejects(
    handle.booted(),
    (error) => {
      assert.match(error.message, /65,536 facet-ID lifetime budget/);
      assert.match(error.message, new RegExp(String(FACET_ID_LIFETIME_BUDGET)));
      assert.equal(error.cause?.message, 'internal error', 'the platform error rides along as the cause');
      return true;
    },
    'a creation failure at the wall must name the budget, not repeat the opaque platform message',
  );
  handle.kill();
  await handle.done.catch(() => {});
}

// ── (3b) below the wall, the error is left alone ────────────────────────────
{
  const { fabric } = setup({
    evaluate: () => { throw new Error('boot exploded for a program reason'); },
  });
  const handle = await spawn(fabric, 1);
  await assert.rejects(
    handle.booted(),
    { message: 'boot exploded for a program reason' },
    'a failure below the wall keeps its own message',
  );
  handle.kill();
  await handle.done.catch(() => {});
}

// ── (4) every name space counts once, in one object ─────────────────────────
// A lease's explicit name and the slot book's names share one budget. Each
// first use is one ID, whichever book minted it, and an explicit name used
// again after a reset is not minted again.
{
  const storage = new Map();
  const first = setup({ storage });
  const lease = await facetPool(first.ctx).acquire('lease-1', async () => ({ class: {} }));
  lease.detach();
  await lease.retire();
  const p1 = await spawn(first.fabric, 1);
  const p2 = await spawn(first.fabric, 2);
  await Promise.all([p1.booted(), p2.booted()]);
  assert.equal(
    (await facetIdBudget(first.ctx)).consumed, 3,
    'lease-1, proc-slot-0 and proc-slot-1 are three IDs',
  );
  p1.kill(); p2.kill();
  await Promise.all([p1.done, p2.done]);

  const second = setup({ storage });
  const again = await facetPool(second.ctx).acquire('lease-1', async () => ({ class: {} }));
  again.detach();
  await again.retire();
  const p3 = await spawn(second.fabric, 3);
  await p3.booted();
  assert.equal(
    (await facetIdBudget(second.ctx)).consumed, 3,
    'after a reset, lease-1 and proc-slot-0 are names this object already minted',
  );
  p3.kill();
  await p3.done;
}

// ── (5) a slot's charge is durable before its facet exists ──────────────────
// The write of the first slot's charge fails: that process never boots and
// no facet is created. The next spawn takes the next slot, and the ledger,
// which counts slots up to their high-water, counts the skipped one with it.
{
  const { world, ctx, fabric } = setup();
  const put = ctx.storage.put;
  let failing = true;
  ctx.storage.put = async (...args) => {
    if (failing) throw new Error('storage write failed');
    return put(...args);
  };
  const refused = await spawn(fabric, 1);
  await assert.rejects(refused.booted(), /storage write failed/);
  refused.kill();
  await refused.done.catch(() => {});
  assert.equal(world.boots.length, 0, 'no facet is created without a durable charge');
  failing = false;
  const next = await spawn(fabric, 2);
  await next.booted();
  assert.equal((await facetIdBudget(ctx)).consumed, 2, 'proc-slot-0, never created, and proc-slot-1');
  next.kill();
  await next.done;
}

console.log('ok - facet-id-ledger (minted counted, durable across resets, wall named)');
