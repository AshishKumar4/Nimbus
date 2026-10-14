#!/usr/bin/env bun
// CPython 3.13.14-2 imports nimbus_fs and nimbus_proc, which a deployment
// whose CPython runner predates them does not give the module: it would fail
// at instantiation. So -2 names a runner key of its own, as bash's rebuilds
// do, and a deployment binds only the build its runner was written for. The
// catalog keeps -1 as its default (--keep-default) for the deployments that
// bind it. What has to hold, with -2's entrypoints as runtime-specs publishes
// them:
//
//   - a deployment that registers only -1's key (cpython-runner) installs -1
//     for `cpython`, and refuses `cpython@3.13.14-2` by its runner;
//   - this tree's core workspace and its hosted runtime install -2 for
//     `cpython` against that catalog, and against a catalog that has only -1
//     refuse it by -1's runner rather than bind a build they were not written
//     for.
//
// Red before: -2 named cpython-runner, -1's key, so the older deployment
// installed -2 when asked and the newer one took the -1 default.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { SPECS } from '../../packages/worker/scripts/runtime-specs.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { RuntimeManager } from '../../packages/core/src/runtime/runtime-manager.ts';
import { ProcessFiles, ProcessView } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { hostedLifecycle } from './lib/hosted-lifecycle.mjs';

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

/** The CPython package `version` names, its bins bound to `entrypoints` (a one-byte payload: resolution reads only the manifest). */
const cpython = (version, entrypoints) => {
  const bytes = new Uint8Array([10]);
  const file = { path: 'bin/python', content: `blobs/cpython-${version}/marker`, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'), size: 1, mode: 'exec' };
  return {
    manifest: { name: 'cpython', version, license: 'PSF-2.0', wasi_namespace: 'wasi_snapshot_preview1', files: [file], entrypoints },
    readBlob: () => bytes,
  };
};
// -1 as the catalog published it.
const v1 = cpython('3.13.14-1', ['python', 'python3'].map((binName) => ({ binName, runner: 'cpython-runner', args: [] })));
const v2 = cpython('3.13.14-2', SPECS['cpython/3.13.14-2'].files.filter((file) => file.runner !== undefined)
  .map(({ binName, runner }) => ({ binName, runner, args: [] })));
/** A shared catalog offering `builds`, its default the first. */
const catalog = (...builds) => ({
  async list() {
    return [{ name: 'cpython', abi: 'wasm32-wasi-nimbus', defaultVersion: builds[0].manifest.version,
      versions: builds.map((build) => ({ version: build.manifest.version, sizeBytes: 1, license: 'PSF-2.0' })) }];
  },
  async resolve(spec) {
    if (spec === 'cpython') return builds[0];
    return builds.find((build) => spec === `cpython@${build.manifest.version}`) ?? null;
  },
});
const openVfs = () => {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  return { harness, vfs: new SqliteVFS(harness.sql, harness.ctx) };
};
const registry = () => {
  const commands = new Map();
  return { register: (name, command) => commands.set(name, command), unregister: (name) => commands.delete(name), has: (name) => commands.has(name), resolve: async (name) => commands.get(name) };
};

// A deployment whose runner predates -2: it registers -1's key alone.
{
  const older = new RuntimeManager({ vfs: new ProcessView(new ProcessFiles(openVfs().vfs).openHost(CRED_KERNEL).fs), registry: registry(), source: catalog(v1, v2) });
  older.registerRunner('cpython-runner', () => async () => 0);
  assert.equal((await older.install('cpython')).version, '3.13.14-1', 'an older deployment keeps the -1 default');
  await assert.rejects(older.install('cpython@3.13.14-2'), /cpython@3\.13\.14-2: runner .* not registered/, 'and refuses -2 by its runner');
  console.log('  ✓ a deployment that binds only -1 keeps -1 and refuses -2 by its runner');
}

// This tree's deployments: a core workspace, and the same composed as the hosted runtime registers it.
for (const [what, open] of [
  ['core', async (runtimeSource) => {
    const { harness } = openVfs();
    return await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, runtimeSource });
  }],
  ['hosted', async (runtimeSource) => {
    const world = createFacetWorld(() => ({ async startProcess() { return { ok: true }; }, async handleHttpRequest() { return new Response('ok'); } }), { resolveConfig: false });
    const harness = createSqliteVfsTestHarness();
    const facetCtx = createFacetCtx(world, 'embedder-do');
    const ctx = { ...facetCtx, storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync }, exports: { SupervisorRPC: ({ props }) => ({ props }) }, getWebSockets: () => [] };
    const env = { WORKSPACES: { idFromName() {}, idFromString() {}, get() {} }, LOADER: world.loader, ASSETS: stagedAssets };
    const processes = new bundle.SessionProcessSupervisor();
    processes.setPidBase(bundle.PID_GEN_STRIDE);
    const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs: new bundle.SqliteVFS(harness.sql, harness.ctx), processes, generation: 1, runtimeSource });
    const runtime = await bundle.composeHostedRuntime({ workspace, ctx, env, ports: new bundle.PortRegistry(), lifecycle: hostedLifecycle(ctx, () => runtime) });
    return workspace;
  }],
]) {
  const fresh = await open(catalog(v1, v2));
  try {
    assert.equal((await fresh.runtimes.install('cpython')).version, '3.13.14-2', `${what}: this tree takes -2 over the -1 default`);
  } finally { await fresh.close(); }
  const stale = await open(catalog(v1));
  try {
    await assert.rejects(stale.runtimes.install('cpython'), /cpython@3\.13\.14-1: runner 'cpython-runner' not registered/, `${what}: a catalog with only -1 is refused by -1's runner`);
  } finally { await stale.close(); }
  console.log(`  ✓ ${what}: -2 against the new catalog; a catalog with only -1 is refused by its runner`);
}
console.log('cpython-runner-contract: ok');
