#!/usr/bin/env bun
// The 65,536 facet-ID lifetime budget, counted instead of prosed about.
//
// A Durable Object admits 65,536 facet IDs over its LIFETIME; the IDs are
// append-only and never reclaimed. The slot book already stops per-spawn burn
// by reusing names — but nothing COUNTED the IDs actually consumed, and the
// exhaustion failure is unrecoverable for the DO while the platform's message
// for it names nothing. What has to hold:
//
//   (1) the ledger counts names ever minted, not spawns: reuse — same
//       incarnation or after a reset — never increments it;
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

// ── (1) names minted are counted; reuse is not ──────────────────────────────
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

  // Release one and spawn again: the freed name is reused, no new ID burned.
  c.kill();
  await c.done;
  const d = await spawn(fabric, 4);
  await d.booted();
  assert.equal(
    (await facetIdBudget(ctx)).consumed, 3,
    'a spawn that reuses a freed name consumes no new facet ID',
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

console.log('ok - facet-id-ledger (minted counted, reuse free, durable across resets, wall named)');
