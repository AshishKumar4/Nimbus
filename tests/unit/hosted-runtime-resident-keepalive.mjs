#!/usr/bin/env bun
// A hosted runtime keeps its embedder's Durable Object in memory while a
// resident process runs, by the same rule the session DO follows.
//
// A resident lives in a facet, and a facet dies with its parent. The platform
// evicts an object after roughly ten seconds with no in-flight event, so a
// quiet resident needs an alarm to be the event. The session DO arms one
// through its own timer mux; a hosted runtime has only its embedder's
// `lifecycle.schedule`, so it asks for a `resident-keepalive` task there and
// the embedder's alarm hands it back through `onScheduled`.
//
// Asserted through composeHostedRuntime's public surface:
//   - nothing asks for the keep-alive before a resident runs;
//   - starting a resident schedules `resident-keepalive` one cadence out;
//   - `onScheduled('resident-keepalive')` schedules the next one while it runs;
//   - once it has exited, `onScheduled` schedules nothing more;
//   - the next resident starts the cycle again.

import assert from 'node:assert/strict';

import { RESIDENT_KEEPALIVE_MS } from '../../packages/platform/src/limits.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

// One graph for the runtime and the workspace it is composed over, so the
// filesystem authority the runtime checks for is the class it knows.
const bundle = await importWorkerBundle({
  'packages/worker/src/workspace-host.ts': ['composeHostedRuntime'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/runtime/port-registry.ts': ['PortRegistry'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/runtime/process-table.ts': ['PID_GEN_STRIDE'],
  'packages/fabric/src/composition.ts': ['composeFabric'],
});

bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

const ASSETS = stagedAssets;

const settle = async (predicate, tries = 400) => {
  for (let i = 0; i < tries && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
};

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}), { resolveConfig: false });
const harness = createSqliteVfsTestHarness();
const facetCtx = createFacetCtx(world, 'embedder-do');
const ctx = {
  ...facetCtx,
  storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync },
  exports: { SupervisorRPC: ({ props }) => ({ props }) },
  getWebSockets: () => [],
};
const env = {
  WORKSPACES: { idFromName() {}, idFromString() {}, get() {} },
  LOADER: world.loader,
  ASSETS,
};

/** Every `lifecycle.schedule` the runtime asked of its embedder. */
const scheduled = [];
const owned = [];
const keepalives = () => scheduled.filter(([task]) => task === 'resident-keepalive');

const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const processes = new bundle.SessionProcessSupervisor();
processes.setPidBase(bundle.PID_GEN_STRIDE);
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
const runtime = await bundle.composeHostedRuntime({
  workspace,
  ctx,
  env,
  ports: new bundle.PortRegistry(),
  lifecycle: {
    waitUntil: (task) => { owned.push(task); facetCtx.waitUntil(task); },
    async schedule(task, at) { scheduled.push([task, at]); },
    async cancel() {},
  },
});

try {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  workspace.registry.register('lifetime-check', async () => {
    entered.resolve();
    await release.promise;
    return 0;
  });
  const ws = { readyState: 1, send() {} };
  await runtime.attachTerminal(ws);
  const beforeInput = owned.length;
  try {
    await runtime.terminalFrame(ws, JSON.stringify({ type: 'input', data: 'lifetime-check\r' }));
    await entered.promise;

    let settled = false;
    const completion = Promise.all(owned.slice(beforeInput)).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'the command completion is still pending after terminalFrame returns');
    release.resolve();
    await completion;
    assert.equal(settled, true);
  } finally { release.resolve(); }
  assert.deepEqual(keepalives(), [], 'no keep-alive before a resident runs');

  // ── starting a resident schedules the keep-alive ────────────────────────
  const before = Date.now();
  const first = await runtime.spawnWorker('export default {}', 'embedder worker', '/home/user', {});
  await settle(() => keepalives().length > 0);
  assert.equal(keepalives().length, 1, `the resident start scheduled resident-keepalive once: ${JSON.stringify(scheduled)}`);
  const [, armedAt] = keepalives()[0];
  assert.ok(
    armedAt >= before + RESIDENT_KEEPALIVE_MS && armedAt <= Date.now() + RESIDENT_KEEPALIVE_MS,
    `one cadence out (got ${armedAt - before}ms, cadence ${RESIDENT_KEEPALIVE_MS}ms)`,
  );
  console.log('  [1] starting a resident schedules resident-keepalive one cadence out');

  // ── the alarm re-arms while it runs ─────────────────────────────────────
  const fired = Date.now();
  await runtime.onScheduled('resident-keepalive');
  assert.equal(keepalives().length, 2, 'the fire scheduled the next keep-alive');
  const [, rearmedAt] = keepalives()[1];
  assert.ok(
    rearmedAt >= fired + RESIDENT_KEEPALIVE_MS && rearmedAt <= Date.now() + RESIDENT_KEEPALIVE_MS,
    `re-armed one cadence out (got ${rearmedAt - fired}ms)`,
  );
  console.log('  [2] onScheduled re-arms while the resident runs');

  // ── no re-arm once it has exited ────────────────────────────────────────
  await runtime.killProcess(first.pid);
  await settle(() => processes.get(first.pid)?.state !== 'running');
  assert.notEqual(processes.get(first.pid)?.state, 'running', 'the resident exited');
  await runtime.onScheduled('resident-keepalive');
  assert.equal(keepalives().length, 2, 'with no resident, the fire schedules nothing');
  console.log('  [3] no re-arm after the resident exits');

  // ── the next resident starts the cycle again ────────────────────────────
  await runtime.spawnWorker('export default {}', 'second worker', '/home/user', {});
  await settle(() => keepalives().length > 2);
  assert.equal(keepalives().length, 3, 'a new resident re-arms the lapsed cycle');
  console.log('  [4] the next resident re-arms the cycle');
} finally {
  await runtime.close();
}

console.log('hosted-runtime-resident-keepalive OK');
