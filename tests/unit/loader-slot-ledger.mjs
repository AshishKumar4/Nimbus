#!/usr/bin/env bun
// Concurrent-dynamic-worker accounting: measured, not counted in prose.
//
// workerd admits ~5-6 concurrent dynamic workers per Durable Object, at most
// 4 concurrent Loader fetches per DO method, and loader-cache entries are
// never released — every distinct loader.get(id) permanently consumes a slot.
// Until now those caps were respected by construction (IN_DO_THRESHOLD = 5
// sits under the fetch cap) and the slots were counted in prose. What has to
// hold:
//
//   (1) distinct loader ids ever gotten are counted per DO; warm reuse of an
//       id adds nothing, a regenerated id is honestly one more slot gone;
//   (2) live concurrent Loader fetches are visible while in flight, with the
//       peak kept after they drain;
//   (3) "Too many concurrent dynamic workers" is classified in the taxonomy,
//       and the failure names the ids holding the slots instead of leaving
//       the platform message unattributed;
//   (4) a resident process's keyed worker and a one-shot's load land on the
//       same per-DO ledger.

import assert from 'node:assert/strict';
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';
import { beginLoaderFetch, loaderLedgerStats } from '../../packages/fabric/src/budgets.ts';
import { classifyMessage } from '../../packages/platform/src/oom-classify.ts';
import { ProcessFabric } from '../../packages/fabric/src/process-fabric.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import {
  createCtxExports,
  createFacetCtx,
  createFacetWorld,
} from './facet-host-harness.mjs';

const CAP_MESSAGE = 'Too many concurrent dynamic workers';

// ── (3a) the taxonomy knows the cap ─────────────────────────────────────────
assert.equal(
  classifyMessage(CAP_MESSAGE), 'dynamic_worker_cap',
  'the platform cap message must classify, not fall to unknown',
);

// ── (1) + (2) the pool's dispatches are on the ledger ───────────────────────
{
  const ctx = { id: { toString: () => 'ledger-session-id' } };
  let midFlight = 0;
  const loader = {
    get() {
      return {
        getEntrypoint: () => ({
          async execute() {
            midFlight = Math.max(midFlight, loaderLedgerStats(ctx).liveFetches);
            await new Promise((resolve) => setTimeout(resolve, 5));
            return 'done';
          },
        }),
      };
    },
  };
  const pool = new IsolatePool({ LOADER: loader }, ctx, { omitSupervisor: true, concurrency: 2 });
  await pool.map((value) => value, ['a', 'b', 'c', 'd']);

  const afterMap = loaderLedgerStats(ctx);
  assert.equal(afterMap.idsEverGotten.length, 2, 'two slots at concurrency 2 → two ids ever gotten');
  assert.equal(midFlight, 2, 'both slots were live at once and the ledger saw them');
  assert.equal(afterMap.liveFetches, 0, 'nothing in flight after the map settles');
  assert.equal(afterMap.peakLiveFetches, 2, 'the peak survives the drain');

  // Warm reuse: the same function on the same slot is the same id — no new
  // permanent slot is consumed, and the ledger must say so.
  await pool.submit((value) => value, 'again');
  assert.equal(loaderLedgerStats(ctx).idsEverGotten.length, 2, 'warm reuse adds no id');
  pool.dispose();
}

// ── (2b) begin/end brackets are idempotent on the end side ──────────────────
// The bracket exists because wrapping the stub call in a ledger-owned async
// frame poisoned the hosting DO (see beginLoaderFetch); the end function may
// therefore sit in a `finally` that can run after an error path already ended
// the fetch, and a double end must not drive the live count negative.
{
  const ctx = { id: { toString: () => 'bracket-session-id' } };
  const end = beginLoaderFetch(ctx);
  assert.equal(loaderLedgerStats(ctx).liveFetches, 1, 'begin counts the fetch live');
  end();
  end();
  assert.equal(loaderLedgerStats(ctx).liveFetches, 0, 'a second end is a no-op, not a negative count');
  assert.equal(loaderLedgerStats(ctx).peakLiveFetches, 1, 'the peak survives');
}

// ── (3b) the cap failure names the ids holding the slots ────────────────────
{
  const ctx = { id: { toString: () => 'capped-session-id' } };
  const loader = {
    get() {
      return { getEntrypoint: () => ({ async execute() { throw new Error(CAP_MESSAGE); } }) };
    },
  };
  const pool = new IsolatePool({ LOADER: loader }, ctx, { omitSupervisor: true, timeoutMs: 0 });
  await assert.rejects(
    pool.submit((value) => value, 'payload'),
    (error) => {
      assert.match(error.message, /Too many concurrent dynamic workers/);
      assert.match(error.message, /never released/);
      const [id] = loaderLedgerStats(ctx).idsEverGotten;
      assert.ok(error.message.includes(id), 'the failure names the id holding a slot');
      return true;
    },
    'the cap failure must carry the per-DO accounting',
  );
  pool.dispose();
}

// ── (4) resident and one-shot workers land on the same ledger ───────────────
adoptCtxExports(createCtxExports(() => { throw new Error('no disk'); }));
{
  const world = createFacetWorld(() => ({
    startProcess: () => Promise.resolve({ ok: true }),
    handleHttpRequest: () => Promise.resolve(new Response('ok')),
  }));
  const ctx = createFacetCtx(world, 'resident-ledger-do');
  let oneShotMidFlight = 0;
  const env = {
    LOADER: {
      get: world.loader.get,
      load() {
        return {
          getEntrypoint: () => ({
            async fetch() {
              oneShotMidFlight = loaderLedgerStats(ctx).liveFetches;
              return new Response('ran');
            },
          }),
        };
      },
    },
  };
  const host = processHostFor(ctx, env, () => ({ readFile() { throw new Error('no disk'); } }));
  const fabric = new ProcessFabric(host);

  const handle = await fabric.startResidentProcess({
    startContract: 'boot',
    pid: 7,
    workerKey: 'nimbus-process:resident-ledger-do:7',
    boot: {
      kind: 'code',
      code: {
        compatibilityDate: '2025-01-01',
        compatibilityFlags: [],
        mainModule: 'worker.js',
        modules: { 'worker.js': 'export default {}' },
      },
    },
    onWriterActivated() {},
    onWriterRetired() {},
  });
  await handle.booted();
  assert.deepEqual(
    loaderLedgerStats(ctx).idsEverGotten,
    ['nimbus-process:resident-ledger-do:7'],
    "the resident process's keyed worker is one permanent slot on this DO",
  );
  handle.kill();
  await handle.done;

  await host.runOnce({
    pid: 8,
    writerId: crypto.randomUUID(),
    code: async () => ({
      compatibilityDate: '2025-01-01',
      compatibilityFlags: [],
      mainModule: 'worker.js',
      modules: { 'worker.js': 'export default {}' },
    }),
    request: new Request('https://run/'),
    onWriterActivated() {},
  }, async (response) => response.text());
  assert.equal(oneShotMidFlight, 1, "the one-shot's run was a live Loader fetch on the same ledger");
  assert.equal(loaderLedgerStats(ctx).liveFetches, 0, 'and it drained');
}

console.log('ok - loader-slot-ledger (ids counted once, live/peak tracked, cap named, both paths on one ledger)');
