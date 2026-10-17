#!/usr/bin/env bun
// Real Vite (`NIMBUS_REAL_VITE=1 vite`) is one of the session's resident
// processes, and lives and ends as every other one does.
//
// Driven through composeHostedRuntime — the real Shell with the `vite`
// builtin, the FacetManager and the SessionProcessSupervisor — over a facet
// world whose program stands in for the generated Vite server:
//   1. `vite` returns once the server's process has started (Vite boots in
//      startProcess), under the identity of the command that ran it, with its
//      env carrying its own SUPERVISOR and the HMR channel, and its port
//      routed to that process;
//   2. `kill <pid>` ends it 143, frees its port and releases its facet;
//   3. `vite stop` does the same, the server exiting 0;
//   4. a second `vite` ends the server already running before it serves;
//   5. killProcess ends it 137;
//   6. a lost facet ends it 137, its port answering with the cause, and the
//      server is never evaluated a second time under the same pid;
// and each end releases the record a new incarnation of the session would
// run the server again from, which is kept while the server runs.
//   7. a new incarnation of the session runs it again: real Vite serves its
//      port from a process that restarts the one it ran before;
//   8. the runtime's close ends it.

import assert from 'node:assert/strict';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { hostedLifecycle } from './lib/hosted-lifecycle.mjs';

const bundle = await importWorkerBundle({
  'packages/worker/src/workspace-host.ts': ['composeHostedRuntime'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/runtime/port-registry.ts': ['PortRegistry'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/runtime/process-table.ts': ['PID_GEN_STRIDE'],
  'packages/core/src/runtime/os-contracts.ts': ['CRED_SESSION_USER'],
  'packages/fabric/src/composition.ts': ['composeFabric', 'adoptCtxExports'],
});

bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

// The generated server, as its facet runs it: one evaluation is one boot.
const world = createFacetWorld(() => {
  const instance = {
    starts: 0,
    async startProcess() { instance.starts++; return { bootMs: 1 }; },
    async handleHttpRequest(request) { return new Response(`vite ${new URL(request.url).pathname}`); },
    async fetch(request) { return instance.handleHttpRequest(request); },
  };
  return instance;
});
const harness = createSqliteVfsTestHarness();
const facetCtx = createFacetCtx(world, 'real-vite-do');
const ctx = {
  ...facetCtx,
  storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync },
  exports: {
    SupervisorRPC: ({ props }) => ({ supervisor: props }),
    CirrusHmrRPC: ({ props }) => ({ hmr: props }),
  },
  getWebSockets: () => [],
};
bundle.adoptCtxExports(ctx.exports);
const env = { WORKSPACES: { idFromName() {}, idFromString() {}, get() {} }, LOADER: world.loader, ASSETS: stagedAssets };

const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const processes = new bundle.SessionProcessSupervisor();
processes.setPidBase(bundle.PID_GEN_STRIDE);
const ports = new bundle.PortRegistry();
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
const runtime = await bundle.composeHostedRuntime({
  workspace,
  ctx,
  env,
  ports,
  lifecycle: hostedLifecycle(ctx, () => runtime),
});

const ROOT = '/home/user/app';
const PORT = 5180;
const user = vfs.as(bundle.CRED_SESSION_USER);
user.mkdir(`${ROOT.slice(1)}/src`, { recursive: true });
user.writeFile(`${ROOT.slice(1)}/package.json`, '{"name":"app","private":true,"type":"module"}');
user.writeFile(`${ROOT.slice(1)}/index.html`, '<!doctype html><script type="module" src="/src/main.js"></script>');
user.writeFile(`${ROOT.slice(1)}/src/main.js`, 'document.body.textContent = "app";');

const running = (pid) => processes.get(pid)?.state === 'running';
const sh = async (command) => {
  const result = await runtime.exec(command, { execId: 'dev-1' });
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
};
const vite = (args = '') => sh(`cd ${ROOT} && NIMBUS_REAL_VITE=1 vite --port ${PORT} --no-install-check ${args}`.trim());
/** The server serving PORT: its pid, and the facet its process lives in. */
const server = () => {
  const pid = ports.get(PORT)?.pid;
  const boot = world.boots.at(-1);
  return { pid, facet: boot?.facetName, boot };
};
/** The record a new incarnation of the session runs `pid`'s server again from (dev-servers.ts). */
const recordOf = (pid) => ctx.storage.get(`dev-server:${pid}`);
const ended = async (pid, code, facet, what) => {
  assert.equal(running(pid), false, `${what}: the server's process ended`);
  assert.equal(processes.get(pid)?.exitCode, code, `${what}: exit ${code}`);
  assert.equal(ports.get(PORT), undefined, `${what}: its port is free`);
  assert.equal(world.liveFacets().includes(facet), false, `${what}: its facet is released`);
  assert.equal(await recordOf(pid), undefined, `${what}: nothing runs it again`);
};

try {
  // ── 1. one resident process, booted before `vite` returns ──────────────
  const started = await vite();
  assert.equal(started.code, 0, started.err);
  const first = server();
  assert.ok(first.pid > bundle.PID_GEN_STRIDE, `the port is bound to a pid of the session's table (${first.pid})`);
  assert.equal(world.boots.length, 1, 'the server was evaluated once');
  assert.equal(first.boot.instance.starts, 1, 'and started before `vite` returned');
  const entry = processes.get(first.pid);
  assert.deepEqual(
    { argv: entry.argv, cred: entry.cred, execId: entry.execId, longRunning: entry.longRunning },
    { argv: ['vite', '--port', String(PORT), '--no-install-check'], cred: bundle.CRED_SESSION_USER, execId: 'dev-1', longRunning: true },
    'it runs as the command that started it: its argv, credential and exec id',
  );
  assert.equal(entry.parentPid, undefined, 'and outlives that command');
  const env0 = first.boot.config.env;
  assert.equal(env0.SUPERVISOR?.supervisor?.pid, first.pid, 'its SUPERVISOR is its own process\'s');
  assert.equal(env0.CIRRUS_HMR?.hmr?.doId, 'real-vite-do', 'its HMR channel is the session\'s');
  const record = await recordOf(first.pid);
  assert.equal(record?.command, `vite --port ${PORT} --no-install-check`, 'while it runs, a new incarnation runs its command again');
  assert.deepEqual(record?.env?.NIMBUS_REAL_VITE, '1', 'with the environment it was given');
  assert.deepEqual(record?.ports, [PORT], 'and takes back the link of its port');
  const page = await ports.routeRequest(PORT, new Request('https://session.test/'), '/index.html');
  assert.equal(await page.text(), 'vite /index.html', 'its port routes to the process');
  console.log('  [1] vite returns with Vite booted in one resident process, its port routed to it');

  // ── 2. kill <pid> ───────────────────────────────────────────────────────
  assert.deepEqual(await sh(`kill ${first.pid}`), { code: 0, out: '', err: '' });
  await ended(first.pid, 143, first.facet, 'kill');
  console.log('  [2] kill ends it 143 and frees its port and facet');

  // ── 3. vite stop ────────────────────────────────────────────────────────
  assert.equal((await vite()).code, 0);
  const second = server();
  assert.notEqual(second.pid, first.pid);
  const stop = await sh(`cd ${ROOT} && NIMBUS_REAL_VITE=1 vite stop`);
  assert.equal(stop.code, 0, stop.err);
  assert.match(stop.out, /Dev server stopped/);
  await ended(second.pid, 0, second.facet, 'vite stop');
  console.log('  [3] vite stop ends it, exiting 0');

  // ── 4. a second vite ends the first ─────────────────────────────────────
  assert.equal((await vite()).code, 0);
  const third = server();
  assert.equal((await vite()).code, 0);
  const fourth = server();
  assert.notEqual(fourth.pid, third.pid);
  assert.equal(running(third.pid), false, 'the server it replaced ended');
  assert.equal(processes.get(third.pid)?.exitCode, 143);
  assert.equal(world.liveFacets().includes(third.facet), false, 'its facet is released');
  assert.equal(ports.get(PORT)?.pid, fourth.pid, 'the new one serves the port');
  assert.equal(await recordOf(third.pid), undefined, 'the one it replaced is not run again');
  assert.equal((await recordOf(fourth.pid))?.argv?.join(' '), `vite --port ${PORT} --no-install-check`, 'and the new one is');
  console.log('  [4] a second vite ends the server running before it');

  // ── 5. killProcess ──────────────────────────────────────────────────────
  assert.deepEqual(await runtime.killProcess(fourth.pid), { ok: true, pid: fourth.pid });
  await ended(fourth.pid, 137, fourth.facet, 'killProcess');
  console.log('  [5] killProcess ends it 137');

  // ── 6. a lost facet ─────────────────────────────────────────────────────
  assert.equal((await vite()).code, 0);
  const fifth = server();
  const boots = world.boots.length;
  world.lose(fifth.facet);
  const lost = await ports.routeRequest(PORT, new Request('https://session.test/'), '/');
  assert.notEqual(lost?.status, 200, 'a request to the lost server is not answered by a second evaluation');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(world.boots.length, boots, 'the server is not evaluated again under its pid');
  assert.equal(running(fifth.pid), false, 'the lost server\'s process ended');
  assert.equal(processes.get(fifth.pid)?.exitCode, 137);
  assert.equal(ports.get(PORT), undefined, 'its port is free');
  assert.match(String(ports.ended(PORT)), new RegExp(`pid ${fifth.pid}`), 'and answers with the cause');
  assert.equal(await recordOf(fifth.pid), undefined, 'nothing runs it again');
  console.log('  [6] a lost facet ends it 137, its port answering with the cause');

  // ── 7. a new incarnation runs it again ──────────────────────────────────
  {
    assert.equal((await vite()).code, 0);
    const before = server();
    // As a reset leaves the object: its storage, and a new process table and workspace over the same files.
    const againCtx = { ...ctx, ...createFacetCtx(world, 'real-vite-do', facetCtx.storage.rows), exports: ctx.exports, getWebSockets: () => [] };
    againCtx.storage = { ...againCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync };
    const againProcesses = new bundle.SessionProcessSupervisor();
    againProcesses.setPidBase(2 * bundle.PID_GEN_STRIDE);
    const againPorts = new bundle.PortRegistry();
    const againWorkspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes: againProcesses, generation: 2 });
    const again = await bundle.composeHostedRuntime({ workspace: againWorkspace, ctx: againCtx, env, ports: againPorts, lifecycle: hostedLifecycle(againCtx, () => again) });
    try {
      for (let i = 0; i < 400 && againProcesses.get(againPorts.get(PORT)?.pid)?.state !== 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      const serving = againProcesses.get(againPorts.get(PORT)?.pid);
      assert.equal(serving?.state, 'running', 'real Vite serves its port again');
      assert.deepEqual(serving.restartedFrom, { pid: before.pid, cause: 'session-restart' }, 'from a process that restarts the one it ran before');
      assert.deepEqual(serving.argv, ['vite', '--port', String(PORT), '--no-install-check']);
      assert.equal(serving.execId, 'dev-1');
      assert.equal(world.boots.at(-1).instance.starts, 1, 'booted once');
    } finally {
      await again.close();
      await againWorkspace.close();
    }
    console.log('  [7] a new incarnation runs it again, as a process that restarts the one it ran before');
  }

  // ── 8. the runtime's close ──────────────────────────────────────────────
  assert.equal((await vite()).code, 0);
  const sixth = server();
  await runtime.close();
  assert.equal(running(sixth.pid), false, 'close ended it');
  assert.equal(world.liveFacets().includes(sixth.facet), false, 'and released its facet');
  console.log('  [8] the runtime\'s close ends it');
} finally {
  await runtime.close().catch(() => {});
}

console.log('real-vite-resident-lifecycle OK');
