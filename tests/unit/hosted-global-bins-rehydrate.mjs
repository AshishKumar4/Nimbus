#!/usr/bin/env bun
// A package installed globally (npm install -g) is a shell command again
// after a boot, as with npm: its bin is linked into the prefix's bin, on
// PATH, and the shell finds it there. Nothing restores it, and nothing
// registers it: a bin of a package not under the prefix is no command.
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

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { hostedLifecycle } from './lib/hosted-lifecycle.mjs';
import { npmBinShim } from '../../packages/core/src/runtime/npm-bin-map.ts';

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
// An earlier boot: the workspace seeded, and `npm install -g` left two
// packages under the prefix and their bins in its bin; a package outside it
// has a bin no install linked.
{
  const earlier = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes: new bundle.SessionProcessSupervisor(), generation: 1 });
  const kernel = vfs.as(bundle.CRED_KERNEL);
  const installed = (dir, json, bin, target) => {
    kernel.mkdir(`usr/local/lib/node_modules/${dir}/${target.split('/').slice(0, -1).join('/')}`, { recursive: true, mode: 0o755 });
    kernel.writeFile(`usr/local/lib/node_modules/${dir}/package.json`, JSON.stringify(json));
    kernel.writeFile(`usr/local/lib/node_modules/${dir}/${target}`, `console.log(${JSON.stringify(`${bin} ran`)});\n`);
    kernel.mkdir('usr/local/bin', { recursive: true, mode: 0o755 });
    kernel.writeFile(`usr/local/bin/${bin}`, npmBinShim('/usr/local/bin', `/usr/local/lib/node_modules/${dir}/${target}`));
    kernel.chmod(`usr/local/bin/${bin}`, 0o755);
  };
  installed('fakebin', { name: 'fakebin', version: '1.0.0', bin: { fakebin: 'cli.js' } }, 'fakebin', 'cli.js');
  installed('@scope/tool', { name: '@scope/tool', version: '1.0.0', bin: 'bin/tool.js' }, 'tool', 'bin/tool.js');
  kernel.mkdir('usr/lib/node_modules/stray', { recursive: true, mode: 0o755 });
  kernel.writeFile('usr/lib/node_modules/stray/package.json', JSON.stringify({ name: 'stray', version: '1.0.0', bin: { stray: 'cli.js' } }));
  await earlier.close();
}
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 2 });
const runtime = await bundle.composeHostedRuntime({
  workspace,
  ctx,
  env,
  ports: new bundle.PortRegistry(),
  lifecycle: hostedLifecycle(ctx, () => runtime),
});
const found = async (name) => (await workspace.exec(`command -v ${name}`)).stdout.trim();
assert.equal(await found('fakebin'), '/usr/local/bin/fakebin', 'the global bin is a command, found on PATH');
assert.equal(await found('tool'), '/usr/local/bin/tool', 'and a scoped package\'s bin');
assert.equal(await found('stray'), '', 'a bin no install linked is no command');
// That they run is npm-run-invocation's (a global install, a boot, the bin run): here node is a facet.
assert.equal(workspace.registry.has('fakebin'), false, 'nothing registered it');
console.log('hosted-global-bins-rehydrate: ok');
