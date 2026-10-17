#!/usr/bin/env bun
// The Worker Loader shim's code store reached through a composed host (FAB-2):
// an embedder's Durable Object composes the fabric (composeFabric names its
// namespace and dispatch method) and serves its runtime (composeHostedRuntime).
// The shim's store calls travel the route minted into its binding to that
// host's own dispatch. As on NimbusSession:
//
//   - a Worker carrying a 12 MiB module, over the shim's 8 MiB cache, is
//     durable in the embedder's filesystem before its handle is returned, and
//     a native miss reads it back as it was loaded;
//   - a later build's commit retires it, and a miss then fails as retired;
//   - a process's envelope is refused the store.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const bundle = await importWorkerBundle({
  'packages/worker/src/workspace-host.ts': ['composeHostedRuntime'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/runtime/port-registry.ts': ['PortRegistry'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/runtime/process-table.ts': ['PID_GEN_STRIDE'],
  'packages/fabric/src/composition.ts': ['composeFabric', 'hostRoute'],
  'packages/fabric/src/bindings.ts': ['NimbusLoaderRPC', 'NimbusLoadedWorker', 'NimbusLoadedEntrypoint', 'resolveLoadedEntrypoint'],
  'packages/worker/src/wrangler/loader-code-store.ts': ['loaderCodeRegistry'],
});
bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

const MiB = 1024 * 1024;
const world = createFacetWorld(() => ({ async startProcess() { return { ok: true }; } }), { resolveConfig: false });
const harness = createSqliteVfsTestHarness();
const facetCtx = createFacetCtx(world, 'embedder-do');
const ctx = {
  ...facetCtx,
  storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync, async getAlarm() { return null; }, async setAlarm() {} },
  exports: { SupervisorRPC: ({ props }) => ({ props }) },
  getWebSockets: () => [],
};
let runtime = null;
const env = {
  // The embedder's namespace: its one object is the runtime, whose supervisorOp is its dispatch.
  WORKSPACES: { idFromName: (name) => name, idFromString: (id) => id, get: () => ({ supervisorOp: (envelope) => runtime.supervisorOp(envelope) }) },
  LOADER: world.loader,
  ASSETS: stagedAssets,
};
const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const processes = new bundle.SessionProcessSupervisor();
processes.setPidBase(bundle.PID_GEN_STRIDE);
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
runtime = await bundle.composeHostedRuntime({
  workspace, ctx, env, ports: new bundle.PortRegistry(),
  lifecycle: { waitUntil: (task) => facetCtx.waitUntil(task), async schedule() {}, async cancel() {} },
});

const registry = bundle.loaderCodeRegistry(vfs);
const native = { gets: [] };
const stub = { getEntrypoint: () => ({ fetch: async () => new Response('ok') }) };
const shimEnv = { ...env, LOADER: { load: () => stub, get(key, callback) { native.gets.push(Promise.resolve().then(callback)); return stub; } } };
const exports = {
  NimbusLoadedWorker({ props }) { return Object.assign(Object.create(bundle.NimbusLoadedWorker.prototype), { ctx: { props, exports }, env: shimEnv }); },
  NimbusLoadedEntrypoint({ props }) { return Object.assign(Object.create(bundle.NimbusLoadedEntrypoint.prototype), { ctx: { props, exports }, env: shimEnv }); },
};
const shim = (owner) => Object.assign(Object.create(bundle.NimbusLoaderRPC.prototype), {
  ctx: { props: { depth: 1, namespace: `ns-${owner}`, store: { doId: 'embedder-do', route: bundle.hostRoute(), owner } }, exports },
  env: shimEnv,
});
const missed = async (loaded) => {
  await bundle.resolveLoadedEntrypoint(loaded.getEntrypoint());
  return native.gets.at(-1);
};
const blob = (bytes, fill) => { const data = new Uint8Array(bytes); data.fill(fill); return data.buffer; };
const worker = (modules) => ({ compatibilityDate: '2026-09-26', mainModule: Object.keys(modules)[0], modules });

const first = registry.mint('wrangler-1', 'LOADER');
registry.commit('wrangler-1', [first]);
const big = blob(12 * MiB, 3);
const loaded = await shim(first).load(worker({ 'w.js': 'export default {};', 'big.bin': { data: big } }));
const code = await missed(loaded);
assert.equal(createHash('sha256').update(new Uint8Array(code.modules['big.bin'].data)).digest('hex'), createHash('sha256').update(new Uint8Array(big)).digest('hex'),
  'the 12 MiB module is read back through the composed host as it was loaded');
assert.ok(registry.stats().storeBytes >= 12 * MiB, 'it is in the embedder\'s filesystem');

const second = registry.mint('wrangler-1', 'LOADER');
registry.commit('wrangler-1', [second]);
const third = registry.mint('wrangler-1', 'LOADER');
registry.commit('wrangler-1', [third]);
await assert.rejects(missed(loaded), /loader binding was retired/, 'a retired build\'s Worker is not re-created');

await assert.rejects(runtime.supervisorOp({ op: 'loaderCodeStore', args: [{ kind: 'alive', owner: third }], pid: bundle.PID_GEN_STRIDE + 1 }), /EPERM/,
  'a process\'s envelope is refused the store on the composed host');
assert.equal(await runtime.supervisorOp({ op: 'loaderCodeStore', args: [{ kind: 'alive', owner: third }] }), true, 'the host\'s own call is answered');

console.log('ok - loader-code-store-composed (the store through a composed host: durable, read back, retired, refused to processes)');
