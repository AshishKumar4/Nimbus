#!/usr/bin/env bun
// A dev server the session runs keeps running across a new incarnation of
// the session. While its process runs, the process's spawn is recorded; the
// next incarnation runs its command again, once, under a process spawned the
// same way, which the command adopts. Through the real `vite` command (the
// built-in server) in a hosted runtime composed again over the same workspace
// and storage, as a reset leaves them (writes not synced are lost):
//   - `vite` serves its port from a process of its own;
//   - after a reset that process runs again: the same line, argv, cwd,
//     credential and exec id, with the environment the embedder gives back
//     (no record holds it: ask 62), restarting the old pid
//     ('session-restart'), serving the port, its log saying why; exposed
//     under a name, it is the same application, on the link handed out;
//   - `vite stop` ends it, and the next incarnation runs nothing;
//   - a command that fails again (its node_modules gone) is not retried: its
//     process exits with the command's status and its log says why;
//   - a restore an incarnation did not finish is reported, not run again;
//   - a `vite` the user runs while the restore runs comes after it, and is
//     what serves;
//   - a server whose process ends (its job's line failing after it) stops,
//     its port free and its record gone;
//   - a login file that starts a dev server does not wait forever on the
//     restore, which does not wait on the login files.
// Red before: nothing recorded a dev server's process, so a hosted runtime's
// next incarnation ran nothing.

import assert from 'node:assert/strict';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { hostedLifecycle } from './lib/hosted-lifecycle.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const bundle = await importWorkerBundle({
  'packages/worker/src/workspace-host.ts': ['composeHostedRuntime'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/runtime/port-registry.ts': ['PortRegistry'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/runtime/process-table.ts': ['PID_GEN_STRIDE'],
  'packages/core/src/runtime/os-contracts.ts': ['CRED_SESSION_USER'],
  'packages/fabric/src/composition.ts': ['composeFabric'],
});
const { CRED_SESSION_USER, PID_GEN_STRIDE } = bundle;

bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}), { resolveConfig: false });
const harness = createSqliteVfsTestHarness();
const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const user = vfs.as(CRED_SESSION_USER);
/** The object's storage rows: what outlives each incarnation (only what was synced). */
const rows = new Map();
const env = { WORKSPACES: { idFromName() {}, idFromString() {}, get() {} }, LOADER: world.loader, ASSETS: stagedAssets };
/** The embedder's answer to a relaunch: what it ran each exec with, by exec id. */
const asked = [];
const launchedWith = new Map([['exec-dev-1', { DEV_MARK: 'dev-mark-7f3a' }]]);
const resolveProcessEnv = async (request) => { asked.push(request); return launchedWith.get(request.execId) ?? {}; };

const settle = async (predicate, what, tries = 2000) => {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const recordKeys = () => [...rows.keys()].filter((key) => key.startsWith('dev-server:'));

/** An incarnation of the object: a new process table above the last one's pids, over the same workspace and rows. */
let generation = 0;
let current = null;
/** Every incarnation's runtime: a reset runs none of their teardown, so the test does at its end. */
const runtimes = [];
async function incarnation({ restored = true } = {}) {
  if (current !== null) {
    // The reset: what the last one did not sync is gone, and nothing of it runs teardown.
    current.ctx.storage.crash();
    await current.workspace.close();
  }
  generation += 1;
  const facetCtx = createFacetCtx(world, 'dev-server-restore', rows, { crashable: true });
  const ctx = {
    ...facetCtx,
    storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync },
    exports: { SupervisorRPC: ({ props }) => ({ props }) },
    getWebSockets: () => [],
  };
  const processes = new bundle.SessionProcessSupervisor();
  processes.setPidBase(generation * PID_GEN_STRIDE);
  const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation });
  const ports = new bundle.PortRegistry();
  const runtime = await bundle.composeHostedRuntime({
    workspace, ctx, env, ports, lifecycle: hostedLifecycle(ctx, () => runtime), resolveProcessEnv,
  });
  current = { ctx, processes, ports, workspace, runtime };
  runtimes.push(runtime);
  // Its restore, whole: a previous incarnation's record goes before its link is taken back.
  if (restored) await runtime.restoreDevServers();
  return current;
}
const restarted = (processes) => processes.getAll().filter((entry) => entry.restartedFrom !== undefined);

try {
  // ── a running dev server is run again by the next incarnation ──────────
  const first = await incarnation();
  user.mkdir('home/user/app/node_modules', { recursive: true });
  user.writeFile('home/user/app/index.html', '<!doctype html><title>app</title>');
  user.writeFile('home/user/app/package.json', JSON.stringify({ name: 'app', dependencies: { react: '^18.0.0' } }));
  const started = await first.runtime.exec('vite --port 5173 --no-install-check', { cwd: '/home/user/app', env: { DEV_MARK: 'dev-mark-7f3a' }, execId: 'exec-dev-1' });
  assert.equal(started.exitCode, 0, started.stderr);
  const served = first.ports.get(5173);
  assert.ok(served, 'vite serves its port');
  const server = first.processes.get(served.pid);
  assert.equal(server.state, 'running', 'from a process that runs on after the command returned');
  assert.deepEqual(recordKeys(), [`dev-server:${served.pid}`], 'its spawn is recorded while it runs');
  assert.deepEqual(server.argv, ['vite', '--port', '5173', '--no-install-check']);
  const exposed = await first.runtime.exposeApp(5173, { name: 'web' });
  // Made durable before the reset, as time does.
  await first.ctx.storage.sync();

  let next = await incarnation();
  const [again] = restarted(next.processes);
  assert.ok(again, 'the next incarnation runs it again');
  assert.equal(again.command, 'vite --port 5173 --no-install-check');
  assert.deepEqual(again.argv, server.argv);
  assert.equal(again.cwd, server.cwd);
  assert.deepEqual(again.cred, server.cred);
  assert.equal(again.execId, 'exec-dev-1', 'under the exec id it had');
  assert.deepEqual(again.restartedFrom, { pid: served.pid, cause: 'session-restart' });
  assert.equal(again.state, 'running', 'its command adopted the process and returned');
  assert.equal(next.ports.get(5173)?.pid, again.pid, 'and it serves the port again');
  assert.deepEqual(recordKeys(), [`dev-server:${again.pid}`], 'its record is the new process\'s');
  assert.deepEqual(asked.filter((request) => request.pid === served.pid),
    [{ pid: served.pid, cred: server.cred, record: `dev-server:${served.pid}`, execId: 'exec-dev-1' }],
    'run with the environment the embedder gives back');
  assert.ok(![...rows.values()].some((row) => JSON.stringify(row).includes('dev-mark-7f3a')), 'which no stored row holds');
  const app = (await next.runtime.listApps()).find((listed) => listed.name === 'web');
  assert.deepEqual({ status: app?.status, pid: app?.pid, owner: app?.owner, execId: app?.execId },
    { status: 'running', pid: again.pid, owner: exposed.owner, execId: 'exec-dev-1' }, 'it is the same application');
  assert.equal(next.ports.hasCapability(5173, exposed.capability), true, 'on the link that was handed out');
  const rotated = await next.runtime.rotateLink('web');
  assert.deepEqual({ owner: rotated.owner, pid: rotated.pid }, { owner: exposed.owner, pid: again.pid }, 'and rotates as it');
  const log = (await next.runtime.processLogs(again.pid)).text;
  assert.match(log, /the session restarted: running `vite --port 5173 --no-install-check` again in \/home\/user\/app/);

  // ── a stopped one stays stopped ─────────────────────────────────────────
  const stop = await next.runtime.exec('vite stop', { cwd: '/home/user/app' });
  assert.match(stop.stdout, /Dev server stopped/);
  assert.equal(next.processes.get(again.pid).state, 'exited', 'its process ended');
  await settle(() => recordKeys().length === 0, 'the record to be released');
  next = await incarnation();
  assert.equal(restarted(next.processes).length, 0, 'a stopped dev server is not run again');

  // ── one that fails to start again is not retried ────────────────────────
  const plain = await next.runtime.exec('vite --port 5173', { cwd: '/home/user/app' });
  assert.equal(plain.exitCode, 0, plain.stderr);
  user.rmdir('home/user/app/node_modules');
  next = await incarnation();
  const [failed] = restarted(next.processes);
  assert.ok(failed, 'its command ran again');
  assert.equal(failed.state, 'exited');
  assert.equal(failed.exitCode, 1, 'and its process exited with the command\'s status');
  const failedLog = (await next.runtime.processLogs(failed.pid)).text;
  assert.match(failedLog, /node_modules\/ not found/, 'its log holds what the command said');
  assert.match(failedLog, /`vite --port 5173` did not start again \(exit 1\); run it again in \/home\/user\/app/);
  assert.deepEqual(recordKeys(), [], 'its record is released');
  next = await incarnation();
  assert.equal(restarted(next.processes).length, 0, 'and nothing runs it again');

  // ── a restore an incarnation did not finish is not run again ────────────
  user.mkdir('home/user/app/node_modules');
  const third = await next.runtime.exec('vite --port 5173 --no-install-check', { cwd: '/home/user/app' });
  assert.equal(third.exitCode, 0, third.stderr);
  const [key] = recordKeys();
  rows.set(key, { ...rows.get(key), restoring: true });
  next = await incarnation();
  assert.equal(restarted(next.processes).length, 0, 'a restore that began and never finished is not run again');
  assert.deepEqual(recordKeys(), [], 'and its record is released');

  // ── a server the user starts while the restore runs comes after it ──────
  user.mkdir('home/user/other/node_modules', { recursive: true });
  user.writeFile('home/user/other/index.html', '<!doctype html><title>other</title>');
  const before = await next.runtime.exec('vite --port 5173 --no-install-check', { cwd: '/home/user/app' });
  assert.equal(before.exitCode, 0, before.stderr);
  next = await incarnation({ restored: false });
  const mine = await next.runtime.exec('vite --port 5173 --no-install-check', { cwd: '/home/user/other' });
  assert.equal(mine.exitCode, 0, mine.stderr);
  const serving = next.processes.get(next.ports.get(5173)?.pid);
  assert.equal(serving?.cwd, '/home/user/other', 'the server the user started serves, not the one restored under it');
  assert.equal(restarted(next.processes).length, 1, 'the restore ran first');
  assert.equal(restarted(next.processes)[0].state, 'exited', 'and what it started was replaced');
  assert.deepEqual(recordKeys(), [`dev-server:${serving.pid}`], 'only the user\'s is recorded');
  await next.runtime.exec('vite stop', { cwd: '/home/user/other' });
  await settle(() => recordKeys().length === 0, 'the record to be released');

  // ── a server ends with its process ──────────────────────────────────────
  const job = await next.runtime.startProcess('vite --port 5174 --no-install-check; false', { cwd: '/home/user/app' });
  await settle(() => next.processes.get(job.pid)?.state !== 'running', 'the job to end');
  assert.equal(next.processes.get(job.pid).exitCode, 1, 'its line failed after the server started');
  assert.equal(next.ports.get(5174), undefined, 'the server stopped with its process: its port is free');
  await settle(() => recordKeys().length === 0, 'the record to be released');

  // ── what runs is listed with what the restore runs again (Kinu ask 65) ──
  // Asked at once, as an embedder's recovery asks: "not listed" must mean
  // "not coming". The listing waits for the restore's processes, never for
  // its commands: one that lists what runs itself, and one that never ends
  // (a dev server, then a loop, as a job may run), each answers.
  for (const [what, line] of [
    ['a dev server', 'vite --port 5173 --no-install-check'],
    ['one whose line then lists the apps', 'vite --port 5173 --no-install-check; nimbus app list'],
    ['one whose line never ends', 'vite --port 5173 --no-install-check; while true; do sleep 1; done'],
  ]) {
    await next.runtime.startProcess(line, { cwd: '/home/user/app', execId: 'job-1' });
    await settle(() => next.ports.has(5173), `${what}: its port`);
    await next.ctx.storage.sync();
    next = await incarnation({ restored: false });
    const listed = (await next.runtime.listProcesses()).find((process) => process.execId === 'job-1' && process.state === 'running');
    assert.ok(listed, `${what}: listed at once, under the exec id it had`);
    assert.equal(listed.restartedFrom?.cause, 'session-restart', `${what}: as the restart of the one before`);
    await settle(() => next.ports.has(5173), `${what}: its port again`);
    await next.runtime.killProcess(listed.pid);
    await settle(() => recordKeys().length === 0 && !next.ports.has(5173), `${what}: its record to be released`);
  }

  // ── a login file that starts one, with one to restore ───────────────────
  const recorded = await next.runtime.exec('vite --port 5173 --no-install-check', { cwd: '/home/user/app' });
  assert.equal(recorded.exitCode, 0, recorded.stderr);
  user.writeFile('home/user/.nimbusrc', 'cd /home/user/other && vite --port 5173 --no-install-check\n');
  const composed = incarnation();
  const late = new Promise((resolve) => setTimeout(() => resolve('late'), 30_000));
  assert.notEqual(await Promise.race([composed, late]), 'late', 'the runtime is ready within 30 s');
  next = await composed;
  assert.equal(next.processes.get(next.ports.get(5173)?.pid)?.cwd, '/home/user/other', 'the login file\'s server serves, after the restore');
  user.unlink('home/user/.nimbusrc');
} finally {
  for (const runtime of runtimes) await runtime.close().catch(() => {});
}
console.log('dev-server-restore: ok');
