#!/usr/bin/env bun
// A resident process hosted on a sibling session (NIMBUS_PROCESS_HOST=peer)
// whose host the platform resets is over, and says so.
//
// Measured 2026-10-07 (throwaway aa-mvp): a CPU-bound server's sibling was
// reset after about a second of CPU, the session got "Durable Object reset
// because its code was updated." from its RPC, and then kept the server
// listed as running. Every later request waited 30 s and failed with "peer
// hosts no process", and nothing restarted it. Active native observation and
// the next use after idle both report the lost incarnation. A facet-hosted process that
// ends is reported, its port says so, and its restart policy applies; a
// peer-hosted one must be the same.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { sessionProcessEnv } from '../../packages/worker/src/session/process-env.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { routeToSessionPort } from '../../packages/worker/src/session/port-capability.ts';
import { peerHostFor } from '../../packages/worker/src/session/rpc.ts';
import { hostActivity } from '../../packages/fabric/src/host-activity.ts';
import { runColdStart } from '../../packages/fabric/src/generation.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld, createPeerNamespace } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const SID = 'tenant:peer-loss';
const SERVER = 'const http = require("http"); http.createServer(() => {}).listen(process.env.PORT || 3000);';
const RESET = 'Durable Object reset because its code was updated.';

function setup({ onPeer } = {}) {
  // The module map is left unbuilt: this suite's subject is the host's life.
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('served'); },
  }), { resolveConfig: false });
  const hostEnv = { LOADER: world.loader, ASSETS: stagedAssets };
  const { ns, peers } = createPeerNamespace(world, hostEnv, { onPeer });
  const ctx = createFacetCtx(world, SID);
  const env = { ...hostEnv, NIMBUS_SESSION: ns, NIMBUS_PROCESS_HOST: 'peer' };
  const processes = new SessionProcessSupervisor();
  const portRegistry = new PortRegistry();
  const disk = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(disk.sql, disk.ctx);
  const notices = [];
  const exits = [];
  const fm = new FacetManager(ctx, env, processes, portRegistry, processHostFor, {
    ...sessionProcessEnv(ctx.storage),
    notify: (line) => notices.push(line),
    onExternalExit: (pid, code, reason) => exits.push({ pid, code, reason }),
  });
  fm.setVfs(vfs, new ProcessFiles(vfs));
  const host = { ctx, portRegistry, ensureDurableAppOnPort: (port) => fm.ensureDurableAppOnPort(port) };
  return { peers, ctx, env, world, fm, processes, portRegistry, notices, exits, host };
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
/** The sibling's next incarnation: its storage, and none of its memory. */
const nextIncarnation = (peer, ctx = peer.ctx) => peerHostFor(ctx, peer.env);
const route = (host, port) => routeToSessionPort(host, port, new Request(`https://app.test/`), '/', '');
const rows = async (ctx) => [...(await ctx.storage.list({ prefix: 'resident-launch:' })).values()];

// ── 1. a reset of the sibling ends the process, by name ────────────────────
// ── 2. and its port answers at once, saying why ─────────────────────────────
{
  const { peers, ctx, fm, processes, exits, host, notices } = setup();
  const { pid } = await fm.spawnNode(SERVER, { command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app', port: 20900 });
  await waitFor(() => processes.get(pid)?.state === 'running' && host.portRegistry.get(20900)?.pid === pid, 5_000, 'the server running on 20900');
  assert.equal(await (await route(host, 20900)).text(), 'served', 'the peer-hosted server serves');

  // The next request finds the sibling reset: it fails, naming why, and the process is over.
  peerOf(peers, pid).reset(new Error(RESET));
  const first = await route(host, 20900);
  assert.equal(first.status, 502);
  assert.match(await first.text(), /its host was reset by the platform/);
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
  const { peers, ctx, fm, processes, host, notices } = setup();
  const first = await fm.spawnNode(SERVER, {
    command: 'node crashy.js', argv: ['/home/user/app/crashy.js'], cwd: '/home/user/app', port: 20901,
    env: { NIMBUS_RESTART: 'on-failure' },
  });
  await waitFor(() => host.portRegistry.get(20901)?.pid === first.pid, 5_000, 'the server on 20901');
  const activity = hostActivity(ctx).acquire(); await activity.ready;
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
  activity.release();

  // Its host is reset again before it has run 120 s, and a request finds it: its budget is spent.
  peerOf(peers, restarted.pid).reset(new Error(RESET));
  await route(host, 20901);
  await waitFor(() => processes.get(restarted.pid)?.state === 'exited', 2_000, 'the restart to end');
  await waitFor(
    () => notices.some((line) => /the platform reset the host of "node crashy\.js" again before it had run 120 s since its restart, so it is left stopped/.test(line)),
    5_000, 'the left-stopped notice',
  );
  assert.deepEqual(processes.getRunning().filter((p) => p.command === 'node crashy.js'), [], 'nothing restarts it a second time');
}

// ── 5. idle hosts schedule nothing; the next use validates incarnation ────
{
  const { peers, ctx, world, fm, processes, exits, host } = setup();
  const { pid } = await fm.spawnNode(SERVER, { command: 'node quiet.js', argv: ['/home/user/app/quiet.js'], cwd: '/home/user/app', port: 20902 });
  await waitFor(() => processes.get(pid)?.state === 'running', 5_000, 'the quiet server running');
  const peer = peerOf(peers, pid);
  await peer.peerHost.awaitBoot(`nimbus-process:${SID}:${pid}`);
  assert.equal(peer.ctx.storage.alarmAt, null, 'no hosting-watch alarm is armed');
  assert.equal(processes.get(pid).state, 'running');
  peer.ctx = createFacetCtx(world, peer.ctx.id.toString(), peer.ctx.storage.rows);
  peer.peerHost = nextIncarnation(peer);
  let admitted = false;
  const lease = hostActivity(ctx).acquire();
  try { await lease.ready; admitted = true; }
  finally { lease.release(); }
  assert.equal(admitted, true, 'an unrelated command does not depend on the lost host');
  const result = await route(host, 20902);
  assert.equal(result.status, 502, 'the lost process itself refuses a request');
  await waitFor(() => processes.get(pid)?.state === 'exited', 1_000, 'the process to end when its host reports its reset');
  assert.equal(processes.get(pid).exitCode, 137);
  assert.match(exits.find((e) => e.pid === pid)?.reason ?? '', /its host was reset by the platform/);
}

// ── 6. an active owner observes loss without an application request ───────
{
  const { peers, ctx, fm, processes } = setup();
  const { pid } = await fm.spawnNode(SERVER, { command: 'node retry.js', argv: ['/home/user/app/retry.js'], cwd: '/home/user/app', port: 20903 });
  await waitFor(() => processes.get(pid)?.state === 'running', 5_000, 'the server running');
  const peer = peerOf(peers, pid);
  const activity = hostActivity(ctx).acquire(); await activity.ready;
  peer.die(new Error(RESET));
  await waitFor(() => processes.get(pid)?.state === 'exited', 1_000, 'the active native fetch to report the reset');
  activity.release();
  assert.equal(processes.get(pid).exitCode, 137);
}

// ── 7. cold reconciliation releases a previous coordinator's placements ──
{
  const { peers, ctx, env, world, fm, processes } = setup();
  const { pid } = await fm.spawnNode(SERVER, { command: 'node armed.js', argv: ['/home/user/app/armed.js'], cwd: '/home/user/app', port: 20904 });
  await waitFor(() => processes.get(pid)?.state === 'running', 5_000, 'the server running');
  const peer = peerOf(peers, pid);
  assert.equal((await ctx.storage.list({ prefix: 'process-peer:' })).size, 1);
  const resumed = createFacetCtx(world, SID, ctx.storage.rows);
  processHostFor(resumed, env, () => { throw new Error('peer recovery never reads the coordinator filesystem'); });
  await runColdStart(resumed);
  assert.equal((await resumed.storage.list({ prefix: 'process-peer:' })).size, 0);
  assert.equal((await peer.ctx.storage.list({ prefix: 'hosting:' })).size, 0);
  assert.equal(peer.ctx.storage.alarmAt, null);
}

// ── 8. a host that cannot keep its record does not host the process ─────────
{
  const onPeer = (peer) => {
    const put = peer.ctx.storage.put;
    let failed = false;
    peer.ctx.storage.put = async (key, value) => {
      if (!failed && typeof key === 'string' && key.startsWith('hosting:')) { failed = true; throw new Error('storage write failed'); }
      return put(key, value);
    };
  };
  const { peers, fm, processes } = setup({ onPeer });
  await assert.rejects(
    fm.spawnNode(SERVER, { command: 'node unwatched.js', argv: ['/home/user/app/unwatched.js'], cwd: '/home/user/app', port: 20905 }),
    /storage write failed/,
    'the open is refused, not left unwatched',
  );
  assert.deepEqual(processes.getRunning().filter((p) => p.command === 'node unwatched.js'), [], 'nothing runs');
  for (const peer of peers.values()) {
    assert.equal((await peer.ctx.storage.list({ prefix: 'hosting:' })).size, 0, 'no hosting record is left');
  }
}

console.log('peer-host-loss: ok');
