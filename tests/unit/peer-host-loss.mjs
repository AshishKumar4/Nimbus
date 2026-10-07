#!/usr/bin/env bun
// A resident process hosted on a sibling session (NIMBUS_PROCESS_HOST=peer)
// whose host the platform resets is over, and says so.
//
// Measured 2026-10-07 (throwaway aa-mvp): a CPU-bound server's sibling was
// reset after about a second of CPU, the session got "Durable Object reset
// because its code was updated." from its RPC, and then kept the server
// listed as running. Every later request waited 30 s and failed with "peer
// hosts no process", and nothing restarted it. A facet-hosted process that
// ends is reported, its port says so, and its restart policy applies; a
// peer-hosted one must be the same.

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
import { createFacetCtx, createFacetWorld, createPeerNamespace } from './facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const SID = 'tenant:peer-loss';
const SERVER = 'const http = require("http"); http.createServer(() => {}).listen(process.env.PORT || 3000);';
const RESET = 'Durable Object reset because its code was updated.';

function setup() {
  // The module map is left unbuilt: this suite's subject is the host's life.
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('served'); },
  }), { resolveConfig: false });
  const hostEnv = { LOADER: world.loader, ASSETS: stagedAssets };
  const { ns, peers } = createPeerNamespace(world, hostEnv);
  const ctx = createFacetCtx(world, SID);
  const env = { ...hostEnv, NIMBUS_SESSION: ns, NIMBUS_PROCESS_HOST: 'peer' };
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
  return { peers, ctx, fm, processes, portRegistry, notices, exits, host };
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

/** The sibling hosting `pid`: its name carries the coordinator's id and the pid. */
const peerOf = (peers, pid) => peers.get(`${SID}:proc:${pid}:0`);
const route = (host, port) => routeToSessionPort(host, port, new Request(`https://app.test/`), '/', '');
const rows = async (ctx) => [...(await ctx.storage.list({ prefix: 'resident-launch:' })).values()];

// ── 1. a reset of the sibling ends the process, by name ────────────────────
// ── 2. and its port answers at once, saying why ─────────────────────────────
{
  const { peers, ctx, fm, processes, exits, host, notices } = setup();
  const { pid } = await fm.spawnNode(SERVER, { command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app', port: 20900 });
  await waitFor(() => processes.get(pid)?.state === 'running' && host.portRegistry.get(20900)?.pid === pid, 5_000, 'the server running on 20900');
  assert.equal(await (await route(host, 20900)).text(), 'served', 'the peer-hosted server serves');

  peerOf(peers, pid).die(new Error(RESET));
  await waitFor(() => processes.get(pid)?.state === 'exited', 2_000, 'the process to end when its host is reset');
  assert.equal(processes.get(pid).exitCode, 137, 'it ends as a killed process does');
  const exit = exits.find((e) => e.pid === pid);
  assert.ok(exit, `its end is reported: ${JSON.stringify(exits)}`);
  assert.match(exit.reason, /its host was reset by the platform \(Durable Object reset because its code was updated\.\)/);

  const t0 = Date.now();
  const response = await route(host, 20900);
  const body = await response.text();
  assert.ok(Date.now() - t0 < 1_000, `a request after it fails at once, not after a 30 s wait (${Date.now() - t0} ms)`);
  assert.equal(response.status, 502);
  assert.match(body, /No process listening on port 20900: "node server\.js" \(pid \d+\) ended: its host was reset by the platform/);

  // 'never' (the default): nothing restarts it, and its row is released.
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(processes.getRunning().filter((p) => p.command === 'node server.js'), [], 'restart never: it stays ended');
  assert.deepEqual(await rows(ctx), [], 'its journal row is released');
  assert.ok(!notices.some((line) => /restarting/.test(line)), JSON.stringify(notices));
}

// ── 3. restart on-failure restarts it, and says why ─────────────────────────
// ── 4. a second reset before it has proven itself leaves it stopped ─────────
{
  const { peers, fm, processes, host, notices } = setup();
  const first = await fm.spawnNode(SERVER, {
    command: 'node crashy.js', argv: ['/home/user/app/crashy.js'], cwd: '/home/user/app', port: 20901,
    env: { NIMBUS_RESTART: 'on-failure' },
  });
  await waitFor(() => host.portRegistry.get(20901)?.pid === first.pid, 5_000, 'the server on 20901');
  peerOf(peers, first.pid).die(new Error(RESET));
  const restarted = await waitFor(
    () => processes.getRunning().find((p) => p.command === 'node crashy.js' && p.pid !== first.pid),
    5_000, 'the on-failure restart',
  );
  assert.deepEqual(processes.get(restarted.pid).restartedFrom, { pid: first.pid, cause: 'host-reset' });
  const firstLine = processes.allLogs(restarted.pid).map((chunk) => chunk.data).join('').split('\n')[0];
  assert.match(firstLine, new RegExp(`the platform reset the host of "node crashy\\.js", so it was restarted \\(restart on-failure\\); it was pid ${first.pid}`));
  assert.ok(notices.some((line) => /the platform reset the host of "node crashy\.js" — restarting in 1s \(FencedWork attempt 1\)/.test(line)), JSON.stringify(notices));
  await waitFor(() => host.portRegistry.get(20901)?.pid === restarted.pid, 5_000, 'the restart to take its port');
  assert.equal(await (await route(host, 20901)).text(), 'served', 'the restart serves the port');

  // Its host is reset again before it has run 120 s: its budget is spent.
  peerOf(peers, restarted.pid).die(new Error(RESET));
  await waitFor(() => processes.get(restarted.pid)?.state === 'exited', 2_000, 'the restart to end');
  await waitFor(
    () => notices.some((line) => /the platform reset the host of "node crashy\.js" again before it had run 120 s since its restart, so it is left stopped/.test(line)),
    5_000, 'the left-stopped notice',
  );
  assert.deepEqual(processes.getRunning().filter((p) => p.command === 'node crashy.js'), [], 'nothing restarts it a second time');
}

console.log('peer-host-loss: ok');
