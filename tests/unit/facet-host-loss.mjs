#!/usr/bin/env bun
// A resident process whose own facet the platform kills or resets is over,
// and says so, as a peer-hosted one is (peer-host-loss.mjs).
//
// Measured 2026-10-08 (throwaway aa-astro, main 5a97db8cf): astro dev's
// facet grew past its memory limit after a few page edits. Every later
// request answered, after about 60 s, "Durable Object's isolate exceeded its
// memory limit and was reset."; the session's own incarnation never changed,
// the server stayed listed as running, and nothing restarted it.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { routeToSessionPort } from '../../packages/worker/src/session/port-capability.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const SID = 'tenant:facet-loss';
const SERVER = 'const http = require("http"); http.createServer(() => {}).listen(process.env.PORT || 3000);';
const KILLED = "Durable Object's isolate exceeded its memory limit and was reset.";

function setup() {
  // A facet answers until `killed` names why the platform ended it; from
  // then on every call to it fails with that, as a dead facet's do.
  const state = { killed: null };
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() {
      if (state.killed) throw new Error(state.killed);
      return new Response('served');
    },
  }), { resolveConfig: false });
  const ctx = createFacetCtx(world, SID);
  const env = { LOADER: world.loader, ASSETS: stagedAssets };
  const processes = new SessionProcessSupervisor();
  const portRegistry = new PortRegistry();
  const disk = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(disk.sql, disk.ctx);
  const notices = [];
  const exits = [];
  const fm = new FacetManager(ctx, env, processes, portRegistry, processHostFor, {
    notify: (line) => notices.push(line),
    onExternalExit: (pid, code, reason) => exits.push({ pid, code, reason }),
  });
  fm.setVfs(vfs, new ProcessFiles(vfs));
  const host = { ctx, portRegistry, ensureDurableAppOnPort: (port) => fm.ensureDurableAppOnPort(port) };
  return { state, fm, processes, notices, exits, host };
}

async function waitFor(predicate, budgetMs, what) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor: ${what} within ${budgetMs} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const route = (host, port) => routeToSessionPort(host, port, new Request('https://app.test/'), '/', '');

// ── 1. a facet killed under its process ends the process, by name ──────────
// ── 2. and its port answers at once, saying why ─────────────────────────────
{
  const { state, fm, processes, exits, host, notices } = setup();
  const { pid } = await fm.spawnNode(SERVER, { command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app', port: 20910 });
  await waitFor(() => processes.get(pid)?.state === 'running' && host.portRegistry.get(20910)?.pid === pid, 5_000, 'the server running on 20910');
  assert.equal(await (await route(host, 20910)).text(), 'served');

  state.killed = KILLED;
  const first = await route(host, 20910);
  assert.equal(first.status, 502);
  assert.match(await first.text(), /its host was reset by the platform \(Durable Object's isolate exceeded its memory limit and was reset\.\)/);
  await waitFor(() => processes.get(pid)?.state === 'exited', 2_000, 'the process to end when its facet is killed');
  assert.equal(processes.get(pid).exitCode, 137);
  assert.match(exits.find((e) => e.pid === pid)?.reason ?? '', /its host was reset by the platform/);

  const t0 = Date.now();
  const after = await route(host, 20910);
  assert.ok(Date.now() - t0 < 1_000, `a request after it fails at once (${Date.now() - t0} ms)`);
  assert.equal(after.status, 502);
  assert.match(await after.text(), /No process listening on port 20910: "node server\.js" \(pid \d+\) ended: its host was reset by the platform/);
  assert.ok(!notices.some((line) => /restarting/.test(line)), 'restart never: not restarted');
}

// ── 3. restart on-failure restarts it, and says why ─────────────────────────
{
  const { state, fm, processes, host, notices } = setup();
  const first = await fm.spawnNode(SERVER, {
    command: 'node crashy.js', argv: ['/home/user/app/crashy.js'], cwd: '/home/user/app', port: 20911,
    env: { NIMBUS_RESTART: 'on-failure' },
  });
  await waitFor(() => host.portRegistry.get(20911)?.pid === first.pid, 5_000, 'the server on 20911');
  state.killed = KILLED;
  await route(host, 20911);
  state.killed = null;
  const restarted = await waitFor(
    () => processes.getRunning().find((p) => p.command === 'node crashy.js' && p.pid !== first.pid),
    5_000, 'the on-failure restart',
  );
  assert.deepEqual(processes.get(restarted.pid).restartedFrom, { pid: first.pid, cause: 'host-reset' });
  assert.ok(notices.some((line) => /the platform reset the host of "node crashy\.js" — restarting in 1s/.test(line)), JSON.stringify(notices));
  await waitFor(() => host.portRegistry.get(20911)?.pid === restarted.pid, 5_000, 'the restart to take its port');
  assert.equal(await (await route(host, 20911)).text(), 'served');
}

// ── 4. a request's own failure is not a lost host ───────────────────────────
{
  const { state, fm, processes, host } = setup();
  const { pid } = await fm.spawnNode(SERVER, { command: 'node flaky.js', argv: ['/home/user/app/flaky.js'], cwd: '/home/user/app', port: 20912 });
  await waitFor(() => host.portRegistry.get(20912)?.pid === pid, 5_000, 'the server on 20912');
  state.killed = 'TypeError: something in the handler';
  await route(host, 20912);
  state.killed = null;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(processes.get(pid).state, 'running', 'an error that is not a reset leaves the process running');
  assert.equal(await (await route(host, 20912)).text(), 'served');
}

console.log('facet-host-loss: ok');
