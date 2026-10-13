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
// and each end forgets what would restore the server when the session
// wakes, which it holds while the server runs.
//   7. the runtime's close ends it.

import assert from 'node:assert/strict';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
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
/** What restores the server when the session wakes (routes.restorePersistedDevServer). */
const restoreIntent = () => ctx.storage.get('vite-config');
const ended = async (pid, code, facet, what) => {
  assert.equal(running(pid), false, `${what}: the server's process ended`);
  assert.equal(processes.get(pid)?.exitCode, code, `${what}: exit ${code}`);
  assert.equal(ports.get(PORT), undefined, `${what}: its port is free`);
  assert.equal(world.liveFacets().includes(facet), false, `${what}: its facet is released`);
  assert.equal(await restoreIntent(), undefined, `${what}: nothing restores it`);
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
    { argv: ['--port', String(PORT), '--no-install-check'], cred: bundle.CRED_SESSION_USER, execId: 'dev-1', longRunning: true },
    'it runs as the command that started it: its argv, credential and exec id',
  );
  assert.equal(entry.parentPid, undefined, 'and outlives that command');
  const env0 = first.boot.config.env;
  assert.equal(env0.SUPERVISOR?.supervisor?.pid, first.pid, 'its SUPERVISOR is its own process\'s');
  assert.equal(env0.CIRRUS_HMR?.hmr?.doId, 'real-vite-do', 'its HMR channel is the session\'s');
  assert.equal((await restoreIntent())?.port, PORT, 'while it runs, a session that wakes restores it');
  const page = await ports.routeRequest(PORT, new Request('https://session.test/'), '/index.html');
  assert.equal(await page.text(), 'vite /index.html', 'its port routes to the process');
  console.log('  [1] vite returns with Vite booted in one resident process, its port routed to it');

  // ── 2. kill <pid> ───────────────────────────────────────────────────────
  // An end forgets only its own server's intent: one a start that overlapped
  // it wrote since is kept.
  const own = await restoreIntent();
  await ctx.storage.put('vite-config', { ...own, pid: own.pid + 1 });
  assert.deepEqual(await sh(`kill ${first.pid}`), { code: 0, out: '', err: '' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await restoreIntent())?.pid, own.pid + 1, "an end keeps another server's intent");
  await ctx.storage.delete('vite-config');
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
  assert.equal((await restoreIntent())?.identity?.argv?.join(' '), `--port ${PORT} --no-install-check`, 'and is what a session that wakes restores');
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
  assert.equal(await restoreIntent(), undefined, 'nothing restores it');
  console.log('  [6] a lost facet ends it 137, its port answering with the cause');

  // ── 7. the runtime's close ──────────────────────────────────────────────
  assert.equal((await vite()).code, 0);
  const sixth = server();
  await runtime.close();
  assert.equal(running(sixth.pid), false, 'close ended it');
  assert.equal(world.liveFacets().includes(sixth.facet), false, 'and released its facet');
  console.log('  [7] the runtime\'s close ends it');
} finally {
  await runtime.close().catch(() => {});
}

console.log('real-vite-resident-lifecycle OK');
