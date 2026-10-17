#!/usr/bin/env bun
// @tier slow — waits out twice the 10 s a launch may stall at a stage before it says so
//
// A one-shot whose launch waits at one stage for 10 s says so once, in one
// line: its pid, its command (cut short), the stage, and the ledger's and the
// pacer's state. A user's command that hangs before it runs leaves nothing
// else behind; Workers Logs keeps this line. A launch that is killed while it
// waits, or whose run is entered in time, says nothing.
import assert from 'node:assert/strict';
import { beginLoaderFetch, DO_DYNAMIC_WORKER_LIMIT } from '../../packages/fabric/src/budgets.ts';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';
import { createAuthority } from './lib/resident-body.mjs';

const authority = createAuthority();
adoptSessionSupervisor(authority.host, () => {});
const managerOn = (name, loader) => {
  const ctx = createFacetCtx(createFacetWorld(() => ({})), name);
  return { ctx, manager: oneShotManager(name, { host: authority.host, rawVfs: authority.rawVfs, loader, ctx }) };
};
// Admission: every worker of its object held.
const admission = managerOn('launch-stall-admission', runnerLoader('launch-stall-admission'));
// Load: a worker the platform never starts (its run never entered, never answered).
const load = managerOn('launch-stall-load', {
  load: () => ({ getEntrypoint: () => ({ run: () => new Promise(() => {}), [Symbol.dispose]() {} }), [Symbol.dispose]() {} }),
  get() { throw new Error('a one-shot never takes the keyed loader path'); },
});

const reports = [];
const warn = console.warn;
console.warn = (...args) => {
  const line = args.join(' ');
  if (line.startsWith('[facet-manager] launch stalled: ')) reports.push(JSON.parse(line.slice('[facet-manager] launch stalled: '.length)));
  else warn(...args);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const waitingAt = async ({ manager }, stage, count) => {
  while (manager.launchState().launches.filter((launch) => launch.stage === stage).length < count) await settle();
  return manager.launchState().launches.map(({ pid }) => pid);
};
const run = ({ manager }, opts = {}) => manager.exec('process.stdout.write("ran\\n")', { cwd: '/home/user', captureOutput: true, ...opts });
try {
  // No program runs before the checks below, so the timers and console they read are this test's.
  const holds = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(admission.ctx, `held-${i}`));
  const longCommand = `node -e ${'x'.repeat(5000)}`;
  const killAdmitting = new AbortController();
  const killedAdmitting = run(admission, { signal: killAdmitting.signal });
  const [killedAdmittingPid] = await waitingAt(admission, 'admission', 1);
  killAdmitting.abort();
  await killedAdmitting.catch(() => {});
  const held = run(admission, { command: longCommand });
  const [heldPid] = await waitingAt(admission, 'admission', 1);

  const killLoading = new AbortController();
  const killedLoading = run(load, { signal: killLoading.signal });
  const [killedLoadingPid] = await waitingAt(load, 'load', 1);
  killLoading.abort();
  await killedLoading.catch(() => {});
  const stuckLoading = new AbortController();
  const stuck = run(load, { signal: stuckLoading.signal });
  const [stuckPid] = await waitingAt(load, 'load', 1);

  await new Promise((resolve) => setTimeout(resolve, 10_500));
  const byPid = Object.fromEntries(reports.map((report) => [report.pid, report]));
  assert.deepEqual(Object.keys(byPid).map(Number).sort(), [heldPid, stuckPid].sort(), `one line each for the launches still waiting: ${JSON.stringify(reports)}`);
  assert.ok(!(killedAdmittingPid in byPid) && !(killedLoadingPid in byPid), 'the launches killed while they waited said nothing');
  assert.equal(byPid[heldPid].stage, 'admission');
  assert.deepEqual(byPid[heldPid].ledger, { inFlight: DO_DYNAMIC_WORKER_LIMIT, waiting: 1, pauseMs: 0 }, 'with every worker held, and itself waiting');
  assert.equal(byPid[heldPid].command, `${longCommand.slice(0, 200)}…`, 'its command cut short');
  assert.equal(byPid[stuckPid].stage, 'load', 'a worker loaded but never started is still its launch');
  assert.ok(byPid[stuckPid].command.startsWith('node'), byPid[stuckPid].command);
  for (const report of reports) assert.ok(report.ms >= 10_000, `it waited the stall's length (${report.ms} ms)`);

  await new Promise((resolve) => setTimeout(resolve, 10_500));
  assert.equal(reports.length, 2, 'still waiting, they say nothing more');

  // Let in, the held one runs.
  holds[0]();
  const result = await held;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, 'ran\n');
  for (const end of holds.slice(1)) end();
  stuckLoading.abort();
  await stuck.catch(() => {});
} finally {
  console.warn = warn;
}
console.log('one-shot-launch-stall-report: a stalled launch says where, once');
