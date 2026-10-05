#!/usr/bin/env bun
// A one-shot program (`node -e`, a child_process child, a shell job) is one
// Dynamic Worker in flight for its run, and the Durable Object may have
// DO_DYNAMIC_WORKER_LIMIT of those at once. The run is let in by the
// ledger rather than started regardless. What has to hold:
//
//   (1) with room, a run starts at once and gives its slot back when it ends;
//   (2) with none, it waits, its module map not yet assembled and nothing
//       loaded, and starts the moment a holder's release makes room;
//   (3) a burst wider than the limit never has more than the limit in
//       flight, and every run in it completes, as room frees up;
//   (4) aborting the run's request (a kill) while it waits rejects it with
//       the abort, holding nothing, assembling nothing, loading nothing, and
//       the next waiter keeps its place;
//   (5) inside a launch admission (a child_process child's), the run is the
//       admission's worker whatever pid its runtime runs it as (Bun's runner
//       allocates its own): with the admission the tenth worker it runs at
//       once, where it used to wait for room its own admission held. A
//       second run while the first holds the admission waits its turn.
//
// Before, a run took its hold just before its fetch and never waited: a
// burst of 15 had 15 in flight, past the platform's limit.

import assert from 'node:assert/strict';
import {
  beginLoaderFetch,
  DO_DYNAMIC_WORKER_LIMIT,
  dynamicWorkerHeadroom,
  loaderLedgerStats,
  withLaunchAdmission,
} from '../../packages/fabric/src/budgets.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { createCtxExports, createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

adoptCtxExports(createCtxExports(() => { throw new Error('no disk'); }));

/** A host whose one-shot runs end when the test says so. */
function oneShotHost(doId) {
  const world = createFacetWorld(() => ({}));
  const ctx = createFacetCtx(world, doId);
  const log = { assembled: 0, loaded: 0, running: 0, peakRunning: 0, peakInFlight: 0 };
  /** writerId → end the run (its response resolves). */
  const finish = new Map();
  const env = {
    LOADER: {
      get: world.loader.get,
      load() {
        log.loaded++;
        return {
          getEntrypoint: () => ({
            async fetch(request) {
              const { writerId } = await request.json();
              log.running++;
              log.peakRunning = Math.max(log.peakRunning, log.running);
              log.peakInFlight = Math.max(log.peakInFlight, loaderLedgerStats(ctx).inFlightWorkers.length);
              await new Promise((resolve) => finish.set(writerId, resolve));
              log.running--;
              return new Response(`ran ${writerId}`);
            },
          }),
        };
      },
    },
  };
  const host = processHostFor(ctx, env, () => ({ readFile() { throw new Error('no disk'); } }));
  let pid = 100;
  const run = (signal) => {
    const writerId = crypto.randomUUID();
    const done = host.runOnce({
      pid: ++pid,
      writerId,
      code: async () => {
        log.assembled++;
        return {
          compatibilityDate: '2025-01-01',
          compatibilityFlags: [],
          mainModule: 'worker.js',
          modules: { 'worker.js': 'export default {}' },
        };
      },
      request: new Request('https://run/', { method: 'POST', body: JSON.stringify({ writerId }), signal }),
      onWriterActivated() {},
    }, (response) => response.text());
    return { writerId, done };
  };
  /** End every run that has started; how many that was. */
  const finishStarted = () => {
    const started = [...finish.values()];
    finish.clear();
    for (const resolve of started) resolve();
    return started.length;
  };
  return { ctx, log, run, finish, finishStarted };
}

// ── (1) with room: at once, and the slot comes back ─────────────────────────
{
  const h = oneShotHost('admission-room');
  const { writerId, done } = h.run();
  await tick();
  assert.equal(h.log.running, 1, 'a run with room starts at once');
  assert.deepEqual(loaderLedgerStats(h.ctx).inFlightWorkers, [`one-shot:${writerId}`]);
  h.finish.get(writerId)();
  assert.equal(await done, `ran ${writerId}`);
  assert.equal(dynamicWorkerHeadroom(h.ctx), DO_DYNAMIC_WORKER_LIMIT, 'its slot is given back when it ends');
}

// ── (2) with none: waits, unassembled and unloaded, until a release ────────
{
  const h = oneShotHost('admission-full');
  const holds = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(h.ctx, `resident-${i}`));
  const { writerId, done } = h.run();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(h.log.assembled, 0, 'a run with no room has not assembled its module map');
  assert.equal(h.log.loaded, 0, 'nor loaded a worker');
  assert.equal(loaderLedgerStats(h.ctx).waiting, 1, 'it waits on the ledger');
  holds[3]();
  for (let i = 0; i < 5 && h.log.running === 0; i++) await tick();
  assert.equal(h.log.running, 1, 'a holder ending lets it in');
  assert.equal(loaderLedgerStats(h.ctx).inFlightWorkers.length, DO_DYNAMIC_WORKER_LIMIT, 'in the slot that holder gave back');
  h.finish.get(writerId)();
  assert.equal(await done, `ran ${writerId}`);
  for (const end of holds) end();
  assert.equal(dynamicWorkerHeadroom(h.ctx), DO_DYNAMIC_WORKER_LIMIT);
}

// ── (3) a burst wider than the limit: never past it, every run completes ──
{
  const h = oneShotHost('admission-burst');
  const width = DO_DYNAMIC_WORKER_LIMIT + 5;
  const runs = Array.from({ length: width }, () => h.run());
  const results = Promise.all(runs.map((r) => r.done));
  let completed = 0;
  for (let round = 0; completed < width && round < 50; round++) {
    for (let i = 0; i < 5; i++) await tick();
    completed += h.finishStarted();
  }
  assert.equal(completed, width, 'every run in the burst was let in');
  assert.deepEqual(await results, runs.map((r) => `ran ${r.writerId}`), 'and completed with its own answer');
  assert.equal(h.log.peakRunning, DO_DYNAMIC_WORKER_LIMIT, `at most ${DO_DYNAMIC_WORKER_LIMIT} ran at once (${h.log.peakRunning})`);
  assert.ok(h.log.peakInFlight <= DO_DYNAMIC_WORKER_LIMIT, `the ledger never counted more than the limit (${h.log.peakInFlight})`);
  assert.equal(loaderLedgerStats(h.ctx).peak, DO_DYNAMIC_WORKER_LIMIT);
  assert.equal(dynamicWorkerHeadroom(h.ctx), DO_DYNAMIC_WORKER_LIMIT, 'and the burst gave every slot back');
}

// ── (4) a kill while waiting: rejected with the abort, holding nothing ─────
{
  const h = oneShotHost('admission-abort');
  const holds = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(h.ctx, `resident-${i}`));
  const kill = new AbortController();
  const killed = h.run(kill.signal);
  const next = h.run();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(loaderLedgerStats(h.ctx).waiting, 2);
  const reason = new Error('SIGTERM');
  kill.abort(reason);
  await assert.rejects(killed.done, (error) => error === reason || error?.cause === reason || error?.message === 'SIGTERM',
    'the killed run rejects with its abort');
  assert.equal(loaderLedgerStats(h.ctx).waiting, 1, 'and leaves the queue');
  assert.equal(h.log.assembled, 0, 'having assembled nothing');
  assert.equal(h.log.loaded, 0, 'and loaded nothing');
  assert.equal(loaderLedgerStats(h.ctx).inFlightWorkers.length, DO_DYNAMIC_WORKER_LIMIT, 'or held anything');
  holds[0]();
  for (let i = 0; i < 5 && h.log.running === 0; i++) await tick();
  assert.equal(h.log.running, 1, 'the next waiter takes the freed slot');
  h.finish.get(next.writerId)();
  assert.equal(await next.done, `ran ${next.writerId}`);
  for (const end of holds) end();
}

// ── (5) inside a launch admission: the run is its worker, any pid ─────────
{
  const h = oneShotHost('admission-launch');
  const holds = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT - 1 }, (_, i) => beginLoaderFetch(h.ctx, `resident-${i}`));
  let second;
  const launched = withLaunchAdmission(h.ctx, { pid: 900, ancestors: [] }, undefined, async () => {
    // The runtime runs the program as a pid of its own (h.run allocates one).
    const first = h.run();
    for (let i = 0; i < 5 && h.log.running === 0; i++) await tick();
    assert.equal(h.log.running, 1, "the run claims its launch's admission and starts at once");
    assert.equal(loaderLedgerStats(h.ctx).inFlightWorkers.length, DO_DYNAMIC_WORKER_LIMIT, 'the admission and its run count as one worker');
    second = h.run();
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(h.log.running, 1, 'a second run while the first holds the admission waits its turn');
    assert.equal(loaderLedgerStats(h.ctx).waiting, 1);
    h.finish.get(first.writerId)();
    return first.done;
  });
  const firstAnswer = await launched;
  assert.match(firstAnswer, /^ran /);
  for (let i = 0; i < 5 && h.log.running === 0; i++) await tick();
  assert.equal(h.log.running, 1, 'the second run is let in once the launch ends');
  h.finishStarted();
  await second.done;
  for (const end of holds) end();
  assert.equal(dynamicWorkerHeadroom(h.ctx), DO_DYNAMIC_WORKER_LIMIT);
}

console.log('ok - one-shot-ledger-admission (waits for room unassembled, a burst stays within the limit and completes, a kill while waiting holds nothing, a launch admission is its run\'s worker)');
