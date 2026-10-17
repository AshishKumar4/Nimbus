#!/usr/bin/env bun
// Each CPython build names the contract its host must keep: -2 imports
// nimbus_fs and nimbus_proc, which a runner older than it does not give
// (cpython-runner@2); -3's libc asks again a wait its host gave up on, which
// a host may answer only to it (cpython-runner@3). This tree's runner
// implements all three, so it is registered under each key, and the catalog
// keeps its default (--keep-default) until a later release flips it. What
// has to hold, with -3's entrypoints as runtime-specs publishes them:
//
//   - an older deployment refuses a build newer than its runner by that
//     runner's key, and keeps its default;
//   - this tree, as a core workspace and as the hosted runtime, installs
//     each build when it is the default or asked for, and the default
//     otherwise.
//
// Red before: -2 named cpython-runner, -1's key, so the older deployment
// installed -2 when asked; then this tree registered only @2 and refused -1,
// the catalog's default and every installed session's build.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { SPECS } from '../../packages/worker/scripts/runtime-specs.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { RuntimeManager } from '../../packages/core/src/runtime/runtime-manager.ts';
import { ProcessFiles, ProcessView } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
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
// -1 and -2 as the catalog published them; -3 as runtime-specs publishes it.
const v1 = cpython('3.13.14-1', ['python', 'python3'].map((binName) => ({ binName, runner: 'cpython-runner', args: [] })));
const v2 = cpython('3.13.14-2', ['python', 'python3'].map((binName) => ({ binName, runner: 'cpython-runner@2', args: [] })));
const v3 = cpython('3.13.14-3', SPECS['cpython/3.13.14-3'].files.filter((file) => file.runner !== undefined)
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

// A deployment whose runner predates -3 (core 0.22.0): it registers -1's and -2's keys.
{
  const older = new RuntimeManager({ vfs: new ProcessView(new ProcessFiles(openVfs().vfs).openHost(CRED_KERNEL).fs), registry: registry(), source: catalog(v2, v3, v1) });
  older.registerRunner('cpython-runner', () => async () => 0);
  older.registerRunner('cpython-runner@2', () => async () => 0);
  assert.equal((await older.install('cpython')).version, '3.13.14-2', 'an older deployment keeps the -2 default');
  await assert.rejects(older.install('cpython@3.13.14-3'), /cpython@3\.13\.14-3: runner .* not registered/, 'and refuses -3 by its runner');
  console.log('  ✓ a deployment that binds only -1 and -2 keeps -2 and refuses -3 by its runner');
}

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
    // A workspace binds runtimes through a facet host: without one it registers no runner at all.
    return await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, runtimeSource, facets: localFacetHost(ISOLATE_NETWORK) });
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
  for (const [offered, spec, version] of [
    [[v1], 'cpython', '3.13.14-1'],
    [[v1, v2], 'cpython', '3.13.14-1'],
    [[v1, v2], 'cpython@3.13.14-2', '3.13.14-2'],
    [[v2, v1], 'cpython', '3.13.14-2'],
    [[v2, v3], 'cpython', '3.13.14-2'],
    [[v2, v3], 'cpython@3.13.14-3', '3.13.14-3'],
    [[v3, v2], 'cpython', '3.13.14-3'],
  ]) {
    const workspace = await open(catalog(...offered));
    try {
      const catalogs = `${offered.map((build) => build.manifest.version).join(', ')} (default ${offered[0].manifest.version})`;
      assert.equal((await workspace.runtimes.install(spec)).version, version, `${what}: ${spec} against ${catalogs}`);
    } finally { await workspace.close(); }
  }
  console.log(`  ✓ ${what}: each build when it is the default or asked for, the default otherwise`);
}
console.log('cpython-runner-contract: ok');
