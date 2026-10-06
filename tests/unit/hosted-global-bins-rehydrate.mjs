#!/usr/bin/env bun
// A package installed globally (npm install -g) is a shell command again
// after a boot: the hosted runtime rehydrates /usr/lib/node_modules from the
// workspace's filesystem, and has done so by the time it is composed (a
// floating rehydration used to finish whenever it finished, and a failure
// in it was an unhandled rejection that no try/catch around the call saw).
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

import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
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
  'packages/core/src/runtime/os-contracts.ts': ['CRED_KERNEL'],
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

const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const processes = new bundle.SessionProcessSupervisor();
processes.setPidBase(bundle.PID_GEN_STRIDE);
// An earlier boot: the workspace seeded, and `npm install -g fakebin` left its package on disk.
{
  const earlier = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes: new bundle.SessionProcessSupervisor(), generation: 1 });
  const kernel = vfs.as(bundle.CRED_KERNEL);
  kernel.mkdir('usr/lib/node_modules/fakebin', { recursive: true, mode: 0o755 });
  kernel.writeFile('usr/lib/node_modules/fakebin/package.json', JSON.stringify({ name: 'fakebin', version: '1.0.0', bin: { fakebin: 'cli.js' } }));
  kernel.writeFile('usr/lib/node_modules/fakebin/cli.js', 'console.log("fakebin ran")');
  kernel.mkdir('usr/lib/node_modules/@scope/tool', { recursive: true, mode: 0o755 });
  kernel.writeFile('usr/lib/node_modules/@scope/tool/package.json', JSON.stringify({ name: '@scope/tool', version: '1.0.0', bin: 'bin/tool.js' }));
  kernel.mkdir('usr/lib/node_modules/@scope/tool/bin', { mode: 0o755 });
  kernel.writeFile('usr/lib/node_modules/@scope/tool/bin/tool.js', '');
  await earlier.close();
}
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 2 });
// The workspace restores them itself, once, as it is created (CUTOVER §2.9).
assert.equal(workspace.registry.has('fakebin'), true, 'the global bin is a command once the workspace exists');
await bundle.composeHostedRuntime({
  workspace,
  ctx,
  env,
  ports: new bundle.PortRegistry(),
  lifecycle: { waitUntil: (task) => { facetCtx.waitUntil(task); }, async schedule() {}, async cancel() {} },
});
assert.equal(workspace.registry.has('fakebin'), true, 'the global bin is a command once the runtime is composed');
assert.equal(workspace.registry.has('tool'), true, 'and a scoped package\'s bin');
console.log('hosted-global-bins-rehydrate: ok');
