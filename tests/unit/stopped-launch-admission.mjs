#!/usr/bin/env bun
// The real stop/replay loop, with only preparation and the Worker call
// replaced: its launch admission must be absent while it waits on stdin
// and while it prepares (the lock order, Kinu #29: its bundle and its
// credit before a worker, the broker's admission given back for its first
// preparation too), then reacquired for each run. The nested run hold ends
// as runOneShot ends it after ctx.abort.
import assert from 'node:assert/strict';
import { ReplaySessions } from '../../packages/worker/src/runtime/replay-session.ts';
import { mock } from 'bun:test';
import { ReadAheadBudget, STDIN_SYNC_READ_BYTES } from '../../packages/core/src/runtime/stdin-read.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import {
  beginLoaderFetch,
  beginLoaderFetchWhenFree,
  beginAdmittedFetch,
  bindProcessWaitGraph,
  bindProcessTable,
  claimAdmission,
  DO_DYNAMIC_WORKER_LIMIT,
  loaderLedgerStats,
  issueProcessNews,
  isDynamicWorkerDeadlock,
  setProcessBlocked,
  suspendLaunchAdmission,
  withLaunchAdmission,
} from '../../packages/fabric/src/budgets.ts';

mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {}, DurableObject: class {} }));
const { FacetManager } = await import('../../packages/worker/src/facets/manager.ts');
const tick = async () => { for (let i = 0; i < 30; i++) await null; };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function launch({ stops = 1, signal, ctx = {}, processes = new SessionProcessSupervisor(), entry = processes.spawn('stoppable', [], '/'), onAdmitted, stdout = '', captureOutput = true, deliverOutput } = {}) {
  const waiting = Array.from({ length: stops }, deferred);
  const packets = Array.from({ length: stops }, deferred);
  const preparation = [], runs = [], unread = [];
  let reads = 0;
  const held = () => loaderLedgerStats(ctx).holders[`launch:${entry.pid}`];
  const manager = Object.assign(Object.create(FacetManager.prototype), {
    ctx, processes, filesystem: null,
    hooks: {
      rewindProcessFiles: async () => {},
      deliverOutput,
      stdinChannel: () => ({
        read: () => { waiting[reads].resolve(); return packets[reads++].promise; },
        unread: (back) => unread.push(back),
      }),
    },
    stdinReadAhead: new ReadAheadBudget(STDIN_SYNC_READ_BYTES + 1),
    outputGates: new Map(), replay: new ReplaySessions(), stdinTaken: new Map(),
    launchBundles: new Map(), launching: new Map(), buildAdmissions: new Map(),
    _launchPacer: () => ({ settle() {}, chunks: 0 }),
    _buildProcessBundle: async () => {
      preparation.push(held());
      return { generatedSourcesReleased: true, bundleKey: 'test' };
    },
    _prepareOneShotCode: async () => {
      assert.equal(held(), undefined, 'the map is generated before worker admission');
      return { code: async () => { throw new Error('the Worker call is replaced'); } };
    },
    _staticReadPlan: async () => ({}),
    _installedManifests: async () => '{"files":{}}',
    _recordLaunchLearning: async () => {},
    _w5RecordTermination: () => {},
    // How a run's end is recorded (_end): no ports, writers or residents here.
    portRegistry: new PortRegistry(), processRpcResources: new Map(),
    journalDraining: new Set(), endsAfterDrain: new Map(), _pairedServeFacet: new Map(),
    revokeProcessVfsWriters: () => {},
    _execViaLoader: async (_code, opts) => {
      runs.push(held());
      assert.deepEqual(held(), [entry.pid], 'preparation and the relaunch own exactly one admission hold');
      const end = claimAdmission(ctx, entry.pid);
      assert.equal(typeof end, 'function', 'the run claims its reacquired launch admission');
      assert.deepEqual(held(), [entry.pid, entry.pid], 'outer and nested holds count as one Worker');
      try {
        if (runs.length <= stops) return { stop: {
          v: 3, kind: 'stdin', run: runs.length, until: 'end', stopAt: 0,
          out: stdout ? [{ s: 'stdout', at: 0, b: Buffer.from(stdout).toString('base64') }] : [],
          ...(captureOutput ? { captured: { stdout, stderr: '' } } : {}),
          tape: { seed: [1, 2, 3, 4], now: [], perf: [], random: '', reads: [] },
        } };
        assert.equal(opts.replay.run, stops + 1);
        return { exitCode: 0, stdout: '', stderr: '' };
      } finally { end(); }
    },
  });
  const done = withLaunchAdmission(ctx, { pid: entry.pid }, signal, () => {
    onAdmitted?.();
    return manager.exec('', {
      skipSpawn: true, callerPid: entry.pid,
      env: { NIMBUS_CP_CHILD_PID: String(entry.pid) }, captureOutput, signal,
    });
  });
  return { ctx, processes, entry, manager, done, waiting, packets, preparation, runs, unread, held };
}

// Stop twice: both times there is no launch hold while stdin is open, nor
// while it prepares; the run and the launch's finally each regain/release one.
{
  const h = launch({ stops: 2 });
  for (let i = 0; i < 2; i++) {
    await h.waiting[i].promise;
    assert.equal(h.held(), undefined, 'a stopped child releases its outer launch hold during the stdin wait');
    assert.equal(loaderLedgerStats(h.ctx).headroom, DO_DYNAMIC_WORKER_LIMIT);
    h.packets[i].resolve({ data: new Uint8Array([120]), ended: true });
  }
  assert.equal((await h.done).exitCode, 0);
  assert.deepEqual(h.preparation, Array.from({ length: 3 }, () => undefined), 'every preparation, the first and each replay\'s, holds no worker');
  assert.equal(h.unread.length, 2);
  assert.deepEqual(loaderLedgerStats(h.ctx).inFlightWorkers, []);
  assert.equal(loaderLedgerStats(h.ctx).waiting, 0);
}

// B already queued before the replay is not overtaken. Input can arrive
// while all workers are in flight; the replay is prepared first, holding
// none, and then queues for one.
{
  const h = launch();
  await h.waiting[0].promise;
  const blockers = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(h.ctx, `block-${i}`));
  const b = beginLoaderFetchWhenFree(h.ctx, 'B');
  h.packets[0].resolve({ data: new Uint8Array(0), ended: true });
  await tick();
  assert.deepEqual(loaderLedgerStats(h.ctx).waiters.map((w) => w.key), ['B', `launch:${h.entry.pid}`], 'replay takes its fair place in the ledger queue');
  assert.equal(h.preparation.length, 2, 'the replay was prepared before it queued for a worker');
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
// there is nothing to release twice, and no preparation after the kill (a
// queued replay was prepared before it queued).
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
  assert.equal(h.preparation.length, queued ? 2 : 1);
  assert.equal(loaderLedgerStats(h.ctx).waiting, 0);
  assert.equal(h.held(), undefined);
  for (const end of blockers) end();
  assert.deepEqual(loaderLedgerStats(h.ctx).inFlightWorkers, []);
}

// The reacquisition carries the process's identity: a refusal ends the
// process that already ran, not a spawn that never happened.
{
  const h = launch({ stdout: 'READY\n' });
  await h.waiting[0].promise;
  bindProcessWaitGraph(h.ctx, { children: () => [h.entry.pid], awaits: () => null });
  const blockers = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => {
    const pid = 100 + i;
    const end = beginLoaderFetch(h.ctx, `stuck-${i}`, undefined, pid);
    setProcessBlocked(h.ctx, pid, { blocked: true, frontier: 0, seq: 1 });
    return end;
  });
  h.packets[0].resolve({ data: new Uint8Array(0), ended: true });
  const refused = await h.done;
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.stdout, 'READY\n', 'a refused replay keeps the stopped run\'s captured output');
  assert.match(refused.stderr, /EAGAIN.*resume|resume.*EAGAIN/s);
  assert.equal(h.preparation.length, 2, 'the replay was prepared before its readmission was refused');
  assert.equal(loaderLedgerStats(h.ctx).waiting, 0);
  assert.equal(h.held(), undefined);
  for (const end of blockers) end();
  assert.deepEqual(loaderLedgerStats(h.ctx).inFlightWorkers, []);
}

// R has emitted spawn/READY and stopped. Root plus nine parents awaiting
// queued grandchildren fill the room it released. R's EOF queues its replay
// last; when root blocks too the ledger refuses R. This is an exit of a
// running child, not an initial spawn error, all the way through the broker.
{
  const { ChildProcessManager } = await import('../../packages/core/src/runtime/child-process-manager.ts');
  const ctx = {}, processes = new SessionProcessSupervisor();
  const root = processes.spawn('root', [], '/');
  const endRoot = beginLoaderFetch(ctx, 'root', undefined, root.pid);
  const decisions = [];
  bindProcessTable(ctx, processes, (decide) => decisions.push(decide));
  const made = deferred();
  let r;
  const broker = new ChildProcessManager({
    processes,
    issueNews: (pid) => issueProcessNews(ctx, pid),
    terminate(pid) { return processes.kill(pid, 143); },
    async resolve() { return {
      async run({ pid: processPid, output: hooks, onStarted }) {
        r = launch({ ctx, processes, entry: processes.get(processPid), stdout: 'READY\n', captureOutput: false,
          onAdmitted: onStarted,
          deliverOutput: async (_pid, stream, bytes) => stream === 'stdout' ? hooks.onStdout(bytes) : hooks.onStderr(bytes),
        });
        made.resolve();
        try { return (await r.done).exitCode; }
        catch (error) {
          if (!isDynamicWorkerDeadlock(error)) throw error;
          hooks.onStderr(new TextEncoder().encode(`facet error: ${error.code}: ${error.message}\n`));
          return 1;
        }
      },
    }; },
  });
  const { childPid } = await broker.spawn({ parentPid: root.pid, command: 'node', args: ['R'], cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  await made.promise;
  await r.waiting[0].promise;
  const initial = await broker.wait(childPid, 0, false);
  assert.equal(initial.started, true, 'R has already started');
  const bytes = (reply) => new TextDecoder().decode(Buffer.concat(reply.chunks.map((c) => c.data)));
  assert.equal(bytes(await broker.readOutput(childPid, 1, 0, 0)), 'READY\n');
  const holders = [], parents = [], grandchildren = [], queued = [];
  for (let i = 0; i < 9; i++) {
    const parent = processes.spawn('node parent', [], '/', { parentPid: root.pid });
    parents.push(parent);
    holders.push(beginLoaderFetch(ctx, `parent-${i}`, undefined, parent.pid));
  }
  for (const [i, parent] of parents.entries()) {
    const grandchild = processes.spawn('node grandchild', [], '/', { parentPid: parent.pid });
    const kill = new AbortController();
    grandchildren.push(kill);
    queued.push(beginLoaderFetchWhenFree(ctx, `grandchild-${i}`, { process: grandchild, signal: kill.signal }).then((end) => end(), () => {}));
    setProcessBlocked(ctx, parent.pid, { blocked: true, seq: 1, frontier: 0 });
  }
  assert.equal(decisions.length, 0, 'root still works, so no initial spawn is refused');
  r.packets[0].resolve({ data: new Uint8Array(0), ended: true });
  await tick();
  assert.equal(loaderLedgerStats(ctx).waiters.at(-1).pid, childPid, 'the existing child queues its replay last');
  setProcessBlocked(ctx, root.pid, { blocked: true, seq: 1, frontier: loaderLedgerStats(ctx).news[root.pid].issued });
  assert.equal(decisions.length, 1);
  decisions.shift()();
  const status = await broker.wait(childPid, 1000, true);
  assert.equal(status.spawnError, undefined, 'a refused replay is never reported as spawn node EAGAIN');
  assert.equal(status.exitCode, 1);
  assert.equal(status.signal, null);
  const stderr = bytes(await broker.readOutput(childPid, 2, 0, 0));
  assert.match(stderr, /EAGAIN.*resume|resume.*EAGAIN/s);
  assert.equal(r.runs.length, 1, 'the refused replay ran nothing');
  assert.equal(r.preparation.length, 2, 'it was prepared, holding no worker, before its readmission was refused');
  assert.equal(processes.get(childPid).state, 'exited');
  for (const kill of grandchildren) kill.abort();
  for (const end of holders) end();
  endRoot();
  await Promise.all(queued);
  assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, []);
  assert.equal(loaderLedgerStats(ctx).waiting, 0);
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
    assert.equal(suspendLaunchAdmission(ctx, 8), undefined, 'nor another process\'s launch');
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

console.log('ok - stopped-launch-admission (stdin waits and preparation hold nothing; a prepared replay queues fairly; repeated stops and kills leak nothing)');
