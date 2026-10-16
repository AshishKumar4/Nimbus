#!/usr/bin/env bun
// A new incarnation runs each recorded dev server again once, whoever asks:
// the requests that reach the session while the restore runs (a woken page
// fetches several URLs at once) wait on that one run, and a request after it
// gets its answer without running anything. A destroy, which makes the
// session again with a pid range of its own, ends it: what it has not run
// yet it never runs, and the session made again gets a restore of its own. Through a real workspace shell
// and process table, with a command that serves as the dev servers do: its
// process adopted or spawned (devServerProcess) and recorded (recordDevServer).

import assert from 'node:assert/strict';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const bundle = await importWorkerBundle({
  'packages/worker/src/session/dev-servers.ts': ['devServerProcess', 'recordDevServer', 'restoreDevServers', 'spawnOf'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/runtime/port-registry.ts': ['PortRegistry'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/runtime/process-table.ts': ['PID_GEN_STRIDE'],
});

const harness = createSqliteVfsTestHarness();
const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const rows = new Map();
const world = createFacetWorld(() => ({}), { resolveConfig: false });

let runs = 0;
let release = () => {};
async function incarnation(generation) {
  const processes = new bundle.SessionProcessSupervisor();
  processes.setPidBase(generation * bundle.PID_GEN_STRIDE);
  const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation });
  const host = {
    ctx: createFacetCtx(world, 'dev-server-restore-once', rows),
    processes,
    portRegistry: new bundle.PortRegistry(),
    runtimeWorkspace: workspace,
    ensureRuntimeReady: async () => {},
  };
  // A dev server: it serves until it is stopped, from its own process, recorded while it runs.
  workspace.registry.register('serve', async (ctx) => {
    runs += 1;
    const { entry } = bundle.devServerProcess(processes, 'serve', ctx, () => {});
    await new Promise((resolve) => { release = resolve; });
    await bundle.recordDevServer(host, entry.pid, { ...bundle.spawnOf(entry), env: ctx.env, root: ctx.cwd });
    return 0;
  });
  return { host, workspace };
}

const first = await incarnation(1);
const started = first.workspace.exec('serve');
await new Promise((resolve) => setTimeout(resolve, 0));
release();
assert.equal((await started).exitCode, 0);
assert.equal(runs, 1);
await first.workspace.close();

const next = await incarnation(2);
const asked = [bundle.restoreDevServers(next.host), bundle.restoreDevServers(next.host), bundle.restoreDevServers(next.host)];
for (let i = 0; i < 50 && runs < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(runs, 2, 'the restore runs the command');
release();
const answers = await Promise.all(asked);
assert.equal(runs, 2, 'once, for every request that came while it ran');
assert.ok(answers.every((answer) => answer === answers[0]), 'each gets the one answer');
assert.deepEqual(answers[0], [], 'that it started again');
assert.equal(await bundle.restoreDevServers(next.host), answers[0], 'a later request gets it without a run');
assert.equal(runs, 2);

// A second server, then a destroy while the restore runs the first.
const second = next.workspace.exec('serve');
await new Promise((resolve) => setTimeout(resolve, 0));
release();
assert.equal((await second).exitCode, 0);
assert.equal(runs, 3);
await next.workspace.close();
const destroyed = await incarnation(3);
const restoring = bundle.restoreDevServers(destroyed.host);
for (let i = 0; i < 50 && runs < 4; i++) await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(runs, 4, 'the restore runs the first');
// The destroy: its processes stopped, its storage wiped, and the session made again above every pid it had.
const destroyedBase = destroyed.host.processes.pidBase;
for (const entry of destroyed.host.processes.getAll()) if (entry.state === 'running') destroyed.host.processes.kill(entry.pid);
destroyed.host.processes.setPidBase(4 * bundle.PID_GEN_STRIDE);
rows.clear();
release();
await new Promise((resolve) => setTimeout(resolve, 50));
// What it wrongly started would wait here.
release();
await restoring;
assert.equal(runs, 4, 'and, the session destroyed, never the second');
assert.deepEqual([...rows.keys()].filter((key) => Number(key.slice('dev-server:'.length)) > destroyedBase), [], 'nor records one of its own');
assert.notEqual(bundle.restoreDevServers(destroyed.host), restoring, 'the session made again gets a restore of its own');

// A restore asked for while a destroy runs waits for the session, and then, the session made again, runs nothing.
const late = await incarnation(5);
const lateRuns = runs;
const serving = late.workspace.exec('serve');
await new Promise((resolve) => setTimeout(resolve, 0));
release();
assert.equal((await serving).exitCode, 0);
await late.workspace.close();
const during = await incarnation(6);
let destroyDone = () => {};
const destroying = new Promise((resolve) => { destroyDone = resolve; });
during.host.ensureRuntimeReady = () => destroying;
const askedDuring = bundle.restoreDevServers(during.host);
await new Promise((resolve) => setTimeout(resolve, 10));
for (const entry of during.host.processes.getAll()) if (entry.state === 'running') during.host.processes.kill(entry.pid);
during.host.processes.setPidBase(7 * bundle.PID_GEN_STRIDE);
rows.clear();
destroyDone();
await new Promise((resolve) => setTimeout(resolve, 50));
// What it wrongly started would wait here.
release();
assert.deepEqual(await askedDuring, [], 'it ran nothing');
assert.equal(runs, lateRuns + 1, 'only the start before the destroy ran the command');
assert.deepEqual([...rows.keys()], [], 'and wrote nothing that outlived the wipe');
await during.workspace.close();
await destroyed.workspace.close();
console.log('dev-server-restore-once: ok');
