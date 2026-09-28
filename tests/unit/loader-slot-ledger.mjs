#!/usr/bin/env bun
// Dynamic Worker accounting against the documented per-DO model.
//
// A Durable Object may have DO_DYNAMIC_WORKER_LIMIT distinct Dynamic Workers
// with in-flight requests at once, shared across every concurrent request to
// it; repeated requests to one Dynamic Worker count once, and a worker with
// nothing in flight holds nothing
// (https://developers.cloudflare.com/changelog/post/2026-08-28-durable-objects-dynamic-workers-limit/).
// What has to hold:
//
//   (1) a pool's dispatches are distinct workers in flight while they run
//       and give their slots back when they settle;
//   (2) holds on one worker nest and count once; ending one twice is a no-op;
//   (3) "Too many concurrent dynamic workers" is classified in the taxonomy,
//       and the failure names the workers that were in flight;
//   (4) a resident process holds its worker for as long as it is resident,
//       and a one-shot for its run, on the same per-DO ledger.

import assert from 'node:assert/strict';
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';
import {
  beginLoaderFetch,
  DO_DYNAMIC_WORKER_LIMIT,
  dynamicWorkerHeadroom,
  loaderLedgerStats,
} from '../../packages/fabric/src/budgets.ts';
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

// ── (3a) the taxonomy knows the limit ───────────────────────────────────────
assert.equal(
  classifyMessage(CAP_MESSAGE), 'dynamic_worker_cap',
  'the platform limit message must classify, not fall to unknown',
);

// ── (1) the pool's dispatches are in flight, then released ──────────────────
{
  const ctx = { id: { toString: () => 'ledger-session-id' } };
  let midFlight = 0;
  const loader = {
    get() {
      return {
        getEntrypoint: () => ({
          async execute() {
            midFlight = Math.max(midFlight, loaderLedgerStats(ctx).inFlightWorkers.length);
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
  assert.equal(midFlight, 2, 'both slots were distinct workers in flight at once');
  assert.deepEqual(afterMap.inFlightWorkers, [], 'a settled pool holds no slot');
  assert.equal(afterMap.headroom, DO_DYNAMIC_WORKER_LIMIT, 'the whole budget is back');
  assert.equal(afterMap.peak, 2, 'the peak survives the drain');
  pool.dispose();
}

// ── (2) holds nest per worker; ends are idempotent ──────────────────────────
// The bracket exists because wrapping the stub call in a ledger-owned async
// frame poisoned the hosting DO (see beginLoaderFetch); the end function may
// therefore sit in a `finally` that can run after an error path already ended
// the hold, and a double end must not release someone else's.
{
  const ctx = { id: { toString: () => 'bracket-session-id' } };
  const first = beginLoaderFetch(ctx, 'worker-a');
  const second = beginLoaderFetch(ctx, 'worker-a');
  assert.equal(dynamicWorkerHeadroom(ctx), DO_DYNAMIC_WORKER_LIMIT - 1, 'two requests to one worker count once');
  first();
  first();
  assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, ['worker-a'],
    'a doubled end does not release the request still open');
  second();
  assert.equal(dynamicWorkerHeadroom(ctx), DO_DYNAMIC_WORKER_LIMIT, 'the last end frees the slot');
}

// ── (3b) the limit failure names the workers in flight ──────────────────────
{
  const ctx = { id: { toString: () => 'capped-session-id' } };
  const endResident = beginLoaderFetch(ctx, 'nimbus-process:resident-7');
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
      assert.ok(error.message.includes('nimbus-process:resident-7'), 'the failure names the worker holding a slot');
      assert.match(error.message, new RegExp(`limit of ${DO_DYNAMIC_WORKER_LIMIT}`));
      return true;
    },
    'the limit failure must carry the per-DO accounting',
  );
  endResident();
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
  let oneShotMidFlight = [];
  const env = {
    LOADER: {
      get: world.loader.get,
      load() {
        return {
          getEntrypoint: () => ({
            async fetch() {
              oneShotMidFlight = loaderLedgerStats(ctx).inFlightWorkers;
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
  const resident = loaderLedgerStats(ctx).inFlightWorkers;
  assert.equal(resident.length, 1, 'a booted resident process holds one worker, idle or not');
  assert.ok(resident[0].startsWith('nimbus-process:resident-ledger-do:7'), 'keyed by its loader id');
  assert.equal(dynamicWorkerHeadroom(ctx), DO_DYNAMIC_WORKER_LIMIT - 1);
  handle.kill();
  await handle.done;
  assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, [], 'a killed process gives its slot back');

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
  assert.equal(oneShotMidFlight.length, 1, "the one-shot's run was a worker in flight on the same ledger");
  assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, [], 'and it drained');
}

console.log('ok - loader-slot-ledger (distinct workers in flight counted, released on settle, limit named, one ledger)');
