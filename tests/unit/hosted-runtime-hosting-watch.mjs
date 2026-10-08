#!/usr/bin/env bun
// A hosted runtime that hosts a peer's process watches for its own reset
// through its embedder's lifecycle, and never through an alarm of its own.
//
// MaximumSquirrel (on 6d7c95767): the shared _rpcHostProcess armed fabric's
// timer mux directly. An embedder owns its object's alarm and hands tasks
// back through onScheduled, which had no hosting-watch: the watch never ran,
// and arming it could overwrite the embedder's own alarm.
//
// Asserted through composeHostedRuntime's public surface:
//   - hosting a process asks the lifecycle for 'hosting-watch' and leaves the
//     object's alarm alone;
//   - onScheduled('hosting-watch') reports a hosting record with no process
//     to its session, drops it, and asks for nothing more;
//   - a report the session did not get is asked for again through the
//     lifecycle, and the record is kept.

import assert from 'node:assert/strict';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

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

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}), { resolveConfig: false });
const harness = createSqliteVfsTestHarness();
const facetCtx = createFacetCtx(world, 'embedder-do');
const HOST_ALARM = Date.now() + 3_600_000;
const alarms = [];
const ctx = {
  ...facetCtx,
  storage: {
    ...facetCtx.storage,
    sql: harness.sql,
    transactionSync: harness.ctx.storage.transactionSync,
    // The embedder's own alarm, which nothing of Nimbus may move.
    async getAlarm() { return HOST_ALARM; },
    async setAlarm(at) { alarms.push(at); },
  },
  exports: { SupervisorRPC: ({ props }) => ({ props }) },
  getWebSockets: () => [],
};
const COORDINATOR = 'coordinator-session';
const reports = [];
let failReports = 0;
const env = {
  WORKSPACES: {
    idFromName(name) { return name; },
    idFromString(id) { return id; },
    get(id) {
      return {
        async supervisorOp(envelope) {
          if (failReports > 0) { failReports--; throw new Error('Network connection lost.'); }
          reports.push({ to: id, ...envelope });
          return true;
        },
      };
    },
  },
  LOADER: world.loader,
  ASSETS: stagedAssets,
};
const scheduled = [];
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
    waitUntil: (task) => facetCtx.waitUntil(task),
    async schedule(task, at) { scheduled.push([task, at]); },
    async cancel() {},
  },
});
const watches = () => scheduled.filter(([task]) => task === 'hosting-watch');

// ── hosting a process asks the lifecycle, not the alarm ─────────────────────
{
  const workerKey = 'nimbus-process:coordinator-session:1000001';
  // The host leg is held for the process's life; it settles when it is cancelled.
  const held = runtime.supervisorOp({
    op: 'hostProcess',
    args: [
      { kind: 'code', code: { compatibilityDate: '2026-01-01', compatibilityFlags: [], mainModule: 'p.js', modules: { 'p.js': 'export default {}' } } },
      { coordinatorDoId: COORDINATOR, pid: 1000001, writerId: crypto.randomUUID(), workerKey, webSocketCapability: crypto.randomUUID() },
    ],
  }).catch(() => {});
  for (let i = 0; i < 200 && watches().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(watches().length, 1, `hosting asked the lifecycle for the watch: ${JSON.stringify(scheduled)}`);
  assert.deepEqual(alarms, [], 'the embedder\'s alarm is left alone');
  await runtime.supervisorOp({ op: 'cancelHostProcess', args: [workerKey] }).catch(() => {});
  await Promise.race([held, new Promise((r) => setTimeout(r, 2000))]);
}

// ── a record with no process is reported, dropped, and not watched again ───
{
  await ctx.storage.put('hosting:lost-key', { coordinatorDoId: COORDINATOR, workerKey: 'lost-key', capability: 'cap-1' });
  scheduled.length = 0;
  failReports = 1;
  await runtime.onScheduled('hosting-watch');
  assert.equal(watches().length >= 1, true, 'a report the session did not get is asked for again');
  assert.ok(await ctx.storage.get('hosting:lost-key'), 'and its record is kept');

  scheduled.length = 0;
  await runtime.onScheduled('hosting-watch');
  const lost = reports.filter((r) => r.op === 'hostLost');
  assert.deepEqual(lost.map((r) => [r.to, ...r.args]), [[COORDINATOR, 'lost-key', 'cap-1']], 'the session is told');
  assert.equal(await ctx.storage.get('hosting:lost-key'), undefined, 'the record is dropped');
  assert.deepEqual(alarms, [], 'the embedder\'s alarm is still left alone');
}

await Promise.race([runtime.close(), new Promise((r) => setTimeout(r, 5000))]);
console.log('hosted-runtime-hosting-watch: ok');
process.exit(0);
