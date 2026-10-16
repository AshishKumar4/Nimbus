#!/usr/bin/env bun
// A process that can stop owns one replay session across its runs: its
// journal, the TLS connections it opened through the session, and the
// waits on them. Closing it answers every wait, once; a stop does not
// close it; another process's connection name is refused at once and
// never touched by this one's close; and every way the process ends
// closes it (the process table's terminal hook), as the manager composes
// it.

import assert from 'node:assert/strict';

import { ReplaySessions } from '../../packages/worker/src/runtime/replay-session.ts';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

const TOKEN = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const TARGET = { host: 'example.test', port: 443 };
/** `promise`'s outcome, or 'pending' if it has none within a few turns. */
const outcome = (promise) => Promise.race([
  promise.then((value) => ({ value }), (error) => ({ error: error.message })),
  new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
]);
const running = (replay, pid) => { replay.open(pid, () => {}).journal.start('run-1'); };

// ── closing answers every wait, once ─────────────────────────────────────
{
  const replay = new ReplaySessions();
  running(replay, 7);
  // The outbound asks where a connection goes before the guest opened it,
  // and waits for an upgrade nobody asked for yet; the guest waits for one.
  const connect = replay.outbound(7, 'run-1', 'connect', { token: TOKEN });
  const asked = replay.outbound(7, 'run-1', 'awaitUpgrade', { token: OTHER });
  const upgrade = replay.netTls(7, 'run-1', 'upgrade', TOKEN, {});
  assert.equal(await outcome(connect), 'pending');
  replay.close(7);
  assert.deepEqual(await outcome(connect), { error: 'outbound: no connection was opened under this name' }, 'an unopened connection is answered at once');
  assert.deepEqual(await outcome(asked), { value: null }, 'an upgrade nobody will ask for');
  assert.deepEqual(await outcome(upgrade), { value: { ok: false, error: 'the process ended' } });
  replay.close(7);
  assert.equal(replay.get(7), undefined);
  await assert.rejects(replay.netTls(7, 'run-1', 'open', TOKEN, TARGET), /no such process or connection/);
}

// ── a stop is not an end: the next run finds its connections ────────────
{
  const replay = new ReplaySessions();
  running(replay, 7);
  await replay.netTls(7, 'run-1', 'open', TOKEN, TARGET);
  const asked = replay.outbound(7, 'run-1', 'awaitUpgrade', { token: TOKEN });
  replay.get(7).journal.stopped();
  replay.get(7).journal.start('run-2');
  assert.equal(await outcome(asked), 'pending', 'its waits stand');
  assert.deepEqual(await replay.outbound(7, 'run-2', 'connect', { token: TOKEN }), TARGET);
  replay.close(7);
}

// ── another process's connection name ────────────────────────────────────
{
  const replay = new ReplaySessions();
  running(replay, 1);
  running(replay, 2);
  await replay.netTls(1, 'run-1', 'open', TOKEN, TARGET);
  assert.deepEqual(await outcome(replay.outbound(2, 'run-1', 'connect', { token: TOKEN })), { error: 'no such connection' }, 'refused at once');
  assert.deepEqual(await outcome(replay.netTls(2, 'run-1', 'upgrade', TOKEN, {})), { error: 'no such connection' });
  assert.deepEqual(await replay.outbound(1, 'run-1', 'connect', { token: TOKEN }), TARGET, 'its own process meets it');
  const asked = replay.outbound(1, 'run-1', 'awaitUpgrade', { token: TOKEN });
  replay.close(2);
  assert.equal(await outcome(asked), 'pending', "another process's end leaves its waits alone");
  replay.close(1);
  assert.deepEqual(await outcome(asked), { value: null });
  // The name is free once its process has ended.
  running(replay, 3);
  assert.equal(await replay.netTls(3, 'run-1', 'open', TOKEN, TARGET), true);
  replay.close(3);
}

// ── every way a process ends closes it ───────────────────────────────────
adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({ async startProcess() { return { ok: true }; }, async handleHttpRequest() { return new Response('ok'); } }),
});
const world = createFacetWorld(() => ({ async startProcess() { return { ok: true }; }, async handleHttpRequest() { return new Response('ok'); } }));
const processes = new SessionProcessSupervisor();
const manager = new FacetManager(
  createFacetCtx(world, 'replay-sessions'), { LOADER: world.loader, ASSETS: stagedAssets },
  processes, new PortRegistry(), processHostFor, { requestLaunchTurn: () => {}, onExternalExit: () => {} },
);
for (const [how, end] of [
  ['its exit', (pid) => processes.exit(pid, 0)],
  ['a kill', (pid) => processes.kill(pid, 137)],
]) {
  const { pid } = processes.spawn('node', ['main.js'], '/');
  running(manager.replay, pid);
  const asked = manager.replay.outbound(pid, 'run-1', 'awaitUpgrade', { token: TOKEN });
  end(pid);
  assert.deepEqual(await outcome(asked), { value: null }, `${how} answers its waits`);
  assert.equal(manager.replay.get(pid), undefined, `${how} ends its replay session`);
}

console.log('replay-sessions: ok');
process.exit(0);
