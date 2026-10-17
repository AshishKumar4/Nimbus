#!/usr/bin/env bun
// bash 5.2.37-7 imports nimbus_proc.stat_metadata on bash's own instance,
// which a deployment whose bash runner predates it does not give the module:
// it would fail at instantiation. So -7 names a contract of its own
// (bash-runner@6). This tree's runner implements both contracts (its imports
// are a superset of -6's), so it is registered under both, and the catalog
// keeps -6 as its default (--keep-default) until a later release flips it.
// What has to hold, with -7's entrypoints as runtime-specs publishes them:
//
//   - an older deployment (only bash-runner@5) keeps -6 for `bash`, and
//     refuses `bash@5.2.37-7` by its runner;
//   - this tree, as a core workspace and as the hosted runtime: against a
//     catalog with only -6, `bash` installs -6; against one with both, -7
//     when it is the default or asked for, and -6 while -6 is the default.
//
// Red before: this tree registered only bash-runner@5, and -7 could not be
// installed anywhere.

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

/** The bash package `version` names, its bins bound to `entrypoints` (a one-byte payload: resolution reads only the manifest). */
const bash = (version, entrypoints) => {
  const bytes = new Uint8Array([10]);
  const file = { path: 'bin/bash', content: `blobs/bash-${version}/marker`, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'), size: 1, mode: 'exec' };
  return {
    manifest: { name: 'bash', version, license: 'GPL-3.0-or-later', wasi_namespace: 'wasi_snapshot_preview1', files: [file], entrypoints },
    readBlob: () => bytes,
  };
};
// -6 as the catalog published it.
const v1 = bash('5.2.37-6', [{ binName: 'bash', runner: 'bash-runner@5', args: [] }]);
const v2 = bash('5.2.37-7', SPECS['bash/5.2.37-7'].files.filter((file) => file.runner !== undefined)
  .map(({ binName, runner }) => ({ binName, runner, args: [] })));
/** A shared catalog offering `builds`, its default the first. */
const catalog = (...builds) => ({
  async list() {
    return [{ name: 'bash', abi: 'wasm32-wasi-nimbus', defaultVersion: builds[0].manifest.version,
      versions: builds.map((build) => ({ version: build.manifest.version, sizeBytes: 1, license: 'GPL-3.0-or-later' })) }];
  },
  async resolve(spec) {
    if (spec === 'bash') return builds[0];
    return builds.find((build) => spec === `bash@${build.manifest.version}`) ?? null;
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

// A deployment whose runner predates -7: it registers -6's key alone.
{
  const older = new RuntimeManager({ vfs: new ProcessView(new ProcessFiles(openVfs().vfs).openHost(CRED_KERNEL).fs), registry: registry(), source: catalog(v1, v2) });
  older.registerRunner('bash-runner@5', () => async () => 0);
  assert.equal((await older.install('bash')).version, '5.2.37-6', 'an older deployment keeps the -6 default');
  await assert.rejects(older.install('bash@5.2.37-7'), /bash@5\.2\.37-7: runner .* not registered/, 'and refuses -7 by its runner');
  console.log('  ✓ a deployment that binds only -6 keeps -6 and refuses -7 by its runner');
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
    [[v1], 'bash', '5.2.37-6'],
    [[v1, v2], 'bash', '5.2.37-6'],
    [[v1, v2], 'bash@5.2.37-7', '5.2.37-7'],
    [[v2, v1], 'bash', '5.2.37-7'],
  ]) {
    const workspace = await open(catalog(...offered));
    try {
      const catalogs = `${offered.map((build) => build.manifest.version).join(', ')} (default ${offered[0].manifest.version})`;
      assert.equal((await workspace.runtimes.install(spec)).version, version, `${what}: ${spec} against ${catalogs}`);
    } finally { await workspace.close(); }
  }
  console.log(`  ✓ ${what}: -6 from a catalog with only -6; -7 when it is the default or asked for, -6 while -6 is the default`);
}
console.log('bash-runner-contract: ok');
