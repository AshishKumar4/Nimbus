#!/usr/bin/env bun
// `bun install|i|add` hands the install to npm, saying bun's own spellings
// npm's way: `-p`/`--production` is npm's `--omit=dev` (npm reads `-p` as
// `--parseable`), `-d`/`--dev` npm's `--save-dev` (npm's `-d` is a log
// level), `--optional` `--save-optional`, `--exact` `--save-exact`; every
// other word goes to npm as it is. npm's configuration then reads them as npm
// does. Asserted through composeHostedRuntime: the shell's `bun`, with the
// npm it hands to replaced by one that records what it was given.

import assert from 'node:assert/strict';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { hostedLifecycle } from './lib/hosted-lifecycle.mjs';

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
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
const runtime = await bundle.composeHostedRuntime({
  workspace,
  ctx,
  env,
  ports: new bundle.PortRegistry(),
  lifecycle: hostedLifecycle(ctx, () => runtime),
});
const given = [];
workspace.registry.register('npm', async (cmd) => { given.push(cmd.args); return 0; });

const cases = [
  ['bun install -p', ['install', '--omit=dev']],
  ['bun install --production', ['install', '--omit=dev']],
  ['bun add -d left-pad', ['install', '--save-dev', 'left-pad']],
  ['bun add --dev left-pad', ['install', '--save-dev', 'left-pad']],
  ['bun add --optional left-pad', ['install', '--save-optional', 'left-pad']],
  ['bun i --exact left-pad@1.3.0', ['install', '--save-exact', 'left-pad@1.3.0']],
  ['bun add --registry=https://mirror.example/ left-pad', ['install', '--registry=https://mirror.example/', 'left-pad']],
];
for (const [command, expected] of cases) {
  given.length = 0;
  const result = await runtime.exec(command, { cwd: '/home/user' });
  assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
  assert.deepEqual(given, [expected], command);
}
console.log('bun-install-spellings: ok');
