#!/usr/bin/env bun
// A hosted peer has no lifetime RPC or polling alarm. Native fetch owns
// observation; a cold record is refused on use and kept until release.

import assert from 'node:assert/strict';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { HOSTED_WATCH_HEADER, HOSTED_WEBSOCKET_CAPABILITY_HEADER } from '../../packages/fabric/src/peer-host.ts';

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
const env = {
  WORKSPACES: {
    idFromName(name) { return name; },
    idFromString(id) { return id; },
    get(id) {
      return {
        async supervisorOp(envelope) {
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

// Hosting ends at open; observation is a separate, cancellable native fetch.
{
  const workerKey = 'nimbus-process:coordinator-session:1000001';
  const capability = crypto.randomUUID();
  const opened = runtime.supervisorOp({
    op: 'hostProcess',
    args: [
      { kind: 'code', code: { compatibilityDate: '2026-01-01', compatibilityFlags: [], mainModule: 'p.js', modules: { 'p.js': 'export default {}' } } },
      { coordinatorDoId: COORDINATOR, pid: 1000001, writerId: crypto.randomUUID(), workerKey, webSocketCapability: capability },
    ],
  });
  try {
    const boot = await Promise.race([opened, new Promise(resolve => setTimeout(() => resolve('held'), 1000))]);
    assert.notEqual(boot, 'held', 'hostProcess must not be a permanent residency RPC');
    assert.equal(boot.ok, true);
    assert.equal(watches().length, 0, JSON.stringify(scheduled));
    assert.deepEqual(alarms, [], 'the embedder\'s alarm is left alone');
    const abort = new AbortController();
    const response = await runtime.hostedFetch(new Request('https://watch.invalid/', { signal: abort.signal, headers: {
      [HOSTED_WATCH_HEADER]: workerKey, [HOSTED_WEBSOCKET_CAPABILITY_HEADER]: capability,
    } }));
    assert.equal(response.status, 101);
    const socket = response.webSocket;
    socket.accept();
    const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
    abort.abort();
    await closed;
  } finally { await runtime.supervisorOp({ op: 'cancelHostProcess', args: [workerKey] }); await opened; }
}

// Legacy scheduler events stop. Missing incarnations are found by use, not polling.
{
  await ctx.storage.put('hosting:lost-key', { coordinatorDoId: COORDINATOR, workerKey: 'lost-key', capability: 'cap-1', incarnation: 'old', facet: 'proc-slot-99' });
  scheduled.length = 0;
  await runtime.onScheduled('hosting-watch');
  assert.deepEqual(watches(), [], 'an old hosting-watch event is never rearmed');
  assert.deepEqual(reports, [], 'idle hosts send no periodic loss reports');
  const lost = await runtime.hostedFetch(new Request('https://watch.invalid/', { headers: {
    [HOSTED_WATCH_HEADER]: 'lost-key', [HOSTED_WEBSOCKET_CAPABILITY_HEADER]: 'cap-1',
  } }));
  assert.equal(lost.status, 410);
  assert.match(await lost.text(), /restarted/);
  assert.ok(await ctx.storage.get('hosting:lost-key'), 'loss evidence remains until the coordinator releases it');
  await runtime.supervisorOp({ op: 'cancelHostProcess', args: ['lost-key'] });
  assert.equal(await ctx.storage.get('hosting:lost-key'), undefined, 'the record is dropped');
  assert.deepEqual(alarms, [], 'the embedder\'s alarm is still left alone');
}

// Old peer mode was throwaway-only. Its unnameable rows retire, not a guessed facet.
await ctx.storage.put('hosting:legacy-key', { coordinatorDoId: COORDINATOR, workerKey: 'legacy-key', capability: 'legacy' });
const warnings = [], warn = console.warn, abortFacet = ctx.facets.abort;
console.warn = (...args) => warnings.push(args.join(' '));
ctx.facets.abort = () => assert.fail('legacy cleanup cannot guess a physical facet');
try {
  await runtime.supervisorOp({ op: 'cancelHostProcess', args: ['legacy-key'] });
  await runtime.supervisorOp({ op: 'cancelHostProcess', args: ['legacy-key'] });
  assert.equal(await ctx.storage.get('hosting:legacy-key'), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /peer facet could not be named/);
} finally { console.warn = warn; ctx.facets.abort = abortFacet; }

await runtime.close();
console.log('hosted-runtime-hosting-watch: ok');
process.exit(0);
