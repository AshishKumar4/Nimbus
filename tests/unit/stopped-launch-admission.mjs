#!/usr/bin/env bun
// The real stop/replay loop, with only preparation and the Worker call
// replaced: its launch admission must be absent while it waits on stdin,
// then reacquired before preparation or a run. The nested run hold ends
// as runOneShot ends it after ctx.abort.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { ReadAheadBudget, STDIN_SYNC_READ_BYTES } from '../../packages/core/src/runtime/stdin-read.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import {
  beginLoaderFetch,
  beginLoaderFetchWhenFree,
  beginAdmittedFetch,
  bindProcessWaitGraph,
  claimAdmission,
  DO_DYNAMIC_WORKER_LIMIT,
  loaderLedgerStats,
  setProcessBlocked,
  suspendLaunchAdmission,
  withLaunchAdmission,
} from '../../packages/fabric/src/budgets.ts';

mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {}, DurableObject: class {} }));
const { FacetManager } = await import('../../packages/worker/src/facets/manager.ts');
const tick = async () => { for (let i = 0; i < 30; i++) await null; };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function launch({ stops = 1, signal } = {}) {
  const ctx = {};
  const processes = new SessionProcessSupervisor();
  const entry = processes.spawn('stoppable', [], '/');
  const waiting = Array.from({ length: stops }, deferred);
  const packets = Array.from({ length: stops }, deferred);
  const preparation = [], runs = [], unread = [];
  let reads = 0;
  const held = () => loaderLedgerStats(ctx).holders[`launch:${entry.pid}`];
  const manager = Object.assign(Object.create(FacetManager.prototype), {
    ctx, processes, filesystem: null,
    hooks: {
      rewindProcessFiles: async () => {},
      stdinChannel: () => ({
        read: () => { waiting[reads].resolve(); return packets[reads++].promise; },
        unread: (back) => unread.push(back),
      }),
    },
    stdinReadAhead: new ReadAheadBudget(STDIN_SYNC_READ_BYTES + 1),
    outputGates: new Map(), journals: new Map(), stdinTaken: new Map(),
    netTargets: new Map(), fetchTickets: new Map(),
    _launchPacer: () => ({ settle() {}, chunks: 0 }),
    _buildProcessBundle: async () => {
      preparation.push(held());
      return { generatedSourcesReleased: true, bundleKey: 'test' };
    },
    _staticReadPlan: async () => ({}),
    _recordLaunchLearning: async () => {},
    _execViaLoader: async (_code, opts) => {
      runs.push(held());
      assert.deepEqual(held(), [entry.pid], 'preparation and the relaunch own exactly one admission hold');
      const end = claimAdmission(ctx, entry.pid);
      assert.equal(typeof end, 'function', 'the run claims its reacquired launch admission');
      assert.deepEqual(held(), [entry.pid, entry.pid], 'outer and nested holds count as one Worker');
      try {
        if (runs.length <= stops) return { stop: {
          v: 3, kind: 'stdin', run: runs.length, until: 'end', stopAt: 0, out: [],
          tape: { seed: [1, 2, 3, 4], now: [], perf: [], random: '', reads: [] },
        } };
        assert.equal(opts.replay.run, stops + 1);
        return { exitCode: 0, stdout: '', stderr: '' };
      } finally { end(); }
    },
  });
  const done = withLaunchAdmission(ctx, { pid: entry.pid }, signal, () => manager.exec('', {
    skipSpawn: true, callerPid: entry.pid,
    env: { NIMBUS_CP_CHILD_PID: String(entry.pid) }, captureOutput: true, signal,
  }));
  return { ctx, processes, entry, manager, done, waiting, packets, preparation, runs, unread, held };
}

// Stop twice: both times there is no launch hold while stdin is open;
// preparation, the run and the launch's finally each regain/release one.
{
  const h = launch({ stops: 2 });
  for (let i = 0; i < 2; i++) {
    await h.waiting[i].promise;
    assert.equal(h.held(), undefined, 'a stopped child releases its outer launch hold during the stdin wait');
    assert.equal(loaderLedgerStats(h.ctx).headroom, DO_DYNAMIC_WORKER_LIMIT);
    h.packets[i].resolve({ data: new Uint8Array([120]), ended: true });
  }
  assert.equal((await h.done).exitCode, 0);
  assert.deepEqual(h.preparation, Array.from({ length: 3 }, () => [h.entry.pid]), 'replay preparation happens only after readmission');
  assert.equal(h.unread.length, 2);
  assert.deepEqual(loaderLedgerStats(h.ctx).inFlightWorkers, []);
  assert.equal(loaderLedgerStats(h.ctx).waiting, 0);
}

// B already queued before the replay is not overtaken. Input can arrive
// while all workers are in flight; no replay preparation starts then.
{
  const h = launch();
  await h.waiting[0].promise;
  const blockers = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(h.ctx, `block-${i}`));
  const b = beginLoaderFetchWhenFree(h.ctx, 'B');
  h.packets[0].resolve({ data: new Uint8Array(0), ended: true });
  await tick();
  assert.deepEqual(loaderLedgerStats(h.ctx).waiters.map((w) => w.key), ['B', `launch:${h.entry.pid}`], 'replay takes its fair place in the ledger queue');
  assert.equal(h.preparation.length, 1, 'no preparation while the replay queues');
  blockers[0]();
  const endB = await b;
  await tick();
  assert.equal(h.runs.length, 1, 'B takes the freed slot before the replay');
  endB();
  assert.equal((await h.done).exitCode, 0);
  for (const end of blockers) end();
  assert.deepEqual(loaderLedgerStats(h.ctx).inFlightWorkers, []);
}

// Kill / Ctrl-C while awaiting input and while queued for readmission:
// there is nothing to release twice, and no preparation after the kill.
for (const queued of [false, true]) {
  const controller = new AbortController();
  const h = launch({ signal: controller.signal });
  await h.waiting[0].promise;
  assert.equal(h.held(), undefined);
  const blockers = queued ? Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(h.ctx, `block-${i}`)) : [];
  if (queued) {
    h.packets[0].resolve({ data: new Uint8Array(0), ended: true });
    await tick();
    assert.equal(loaderLedgerStats(h.ctx).waiting, 1);
  }
  if (queued) h.processes.kill(h.entry.pid);
  else controller.abort();
  assert.equal((await h.done).exitCode, 130);
  assert.equal(h.preparation.length, 1);
  assert.equal(loaderLedgerStats(h.ctx).waiting, 0);
  assert.equal(h.held(), undefined);
  for (const end of blockers) end();
  assert.deepEqual(loaderLedgerStats(h.ctx).inFlightWorkers, []);
}

// The reacquisition carries the process's identity: the ledger can refuse
// it as it refuses an initial launch, without a leaked admission or build.
{
  const h = launch();
  await h.waiting[0].promise;
  bindProcessWaitGraph(h.ctx, { children: () => [h.entry.pid], awaits: () => null });
  const blockers = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => {
    const pid = 100 + i;
    const end = beginLoaderFetch(h.ctx, `stuck-${i}`, undefined, pid);
    setProcessBlocked(h.ctx, pid, { blocked: true, frontier: 0, seq: 1 });
    return end;
  });
  h.packets[0].resolve({ data: new Uint8Array(0), ended: true });
  await assert.rejects(h.done, (e) => e.code === 'EAGAIN' && e.pid === h.entry.pid);
  assert.equal(h.preparation.length, 1);
  assert.equal(loaderLedgerStats(h.ctx).waiting, 0);
  assert.equal(h.held(), undefined);
  for (const end of blockers) end();
  assert.deepEqual(loaderLedgerStats(h.ctx).inFlightWorkers, []);
}

// A suspended context cannot lend an unconditional hold to a preparation
// helper or a run. Resumes join one admission, and an abort that races its
// resolution ends the freshly acquired hold before returning to the caller.
{
  const ctx = {};
  assert.equal(suspendLaunchAdmission(ctx), undefined, 'ordinary one-shots have no outer admission to suspend');
  await withLaunchAdmission(ctx, { pid: 7 }, undefined, async () => {
    const run = claimAdmission(ctx, 7);
    assert.throws(() => suspendLaunchAdmission(ctx), /no run in flight/);
    run();
    assert.equal(suspendLaunchAdmission({}), undefined, 'another actor cannot release this admission');
    const resume = suspendLaunchAdmission(ctx);
    assert.equal(beginAdmittedFetch(ctx), undefined);
    assert.equal(claimAdmission(ctx, 7), undefined);
    assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, []);
    const first = resume();
    assert.equal(resume(), first, 'two resumes join one readmission');
    await first;
    assert.deepEqual(loaderLedgerStats(ctx).holders['launch:7'], [7]);
    const again = suspendLaunchAdmission(ctx);
    const controller = new AbortController();
    const pending = again(controller.signal);
    controller.abort(new Error('SIGINT'));
    await assert.rejects(pending, /SIGINT/);
    assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, []);
  });
  assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, []);
}

console.log('ok - stopped-launch-admission (stdin waits hold nothing; replay queues fairly before preparation; repeated stops and kills leak nothing)');
