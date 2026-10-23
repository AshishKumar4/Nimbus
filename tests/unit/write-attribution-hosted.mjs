#!/usr/bin/env bun
// What a hosted session's programs write names their exec (Kinu ask 69),
// through the paths a program's own isolate and the session's tools write by.
// Driven through composeHostedRuntime with the real shell, the node runtime
// handler, the FacetManager and the SessionProcessSupervisor; the program in
// the facet is a stub, so its writes are made the way its shims make them,
// through supervisor ops with its own pid:
//   - a node program run by exec { execId: 'h1' }: its writeFile and mkdir
//     (fsFor: its binding), its strict writeBatch, and a KV put its dev
//     server's Worker makes (the binding's props name the server's pid) all
//     name 'h1';
//   - what the session writes for its launch (the program's image, the
//     kernel's stores, under /.nimbus) and the kernel's own writes name no
//     process: null.
import assert from 'node:assert/strict';

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
  'packages/core/src/runtime/os-contracts.ts': ['CRED_KERNEL', 'CRED_SESSION_USER'],
  'packages/fabric/src/composition.ts': ['composeFabric'],
});

bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

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
const env = { WORKSPACES: { idFromName() {}, idFromString() {}, get() {} }, LOADER: world.loader, ASSETS: stagedAssets };

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

const events = [];
workspace.filesystem.vfs.observeWrites((event) => {
  events.push({ type: event.type, path: event.path, execId: event.execId });
}, { wants: () => false });
const at = (path) => events.filter((event) => event.path === path).map((event) => event.execId);

const failures = [];
const check = async (name, body) => {
  try {
    await body();
  } catch (error) {
    failures.push(`${name}: ${error.stack ?? error.message}`);
  }
};

const kernel = runtime.files.as(bundle.CRED_KERNEL);
await kernel.mkdir('/home/user/app', { recursive: true });
await kernel.chown('/home/user/app', 1000, 1000);
await kernel.writeFile('/home/user/app/server.js', "require('http').createServer((req, res) => res.end('ok')).listen(8080);\n", { mode: 0o644 });

try {
  const launchedFrom = events.length;
  const started = await runtime.exec('node server.js', { execId: 'h1', cwd: '/home/user/app' });
  assert.equal(started.exitCode, 0, JSON.stringify(started));
  const server = processes.getAll().find((entry) => entry.state === 'running' && entry.longRunning && entry.argv.some((arg) => arg.endsWith('server.js')));
  assert.ok(server !== undefined, 'its resident runs');
  const launch = events.slice(launchedFrom);

  await check('the kernel\'s writes and the launch\'s', async () => {
    assert.deepEqual([...new Set(at('/home/user/app/server.js'))], [null], 'the kernel wrote the program');
    const stores = launch.filter((event) => event.path.startsWith('/.nimbus/'));
    assert.deepEqual([...new Set(stores.map((event) => event.execId))].filter((id) => id !== null), [],
      `what the session wrote for its launch is the host's: ${JSON.stringify(stores.slice(0, 5))}`);
  });

  await check('its own fs calls', async () => {
    await runtime.supervisorOp({ op: 'mkdir', args: ['/home/user/app/out', { recursive: true }], pid: server.pid });
    await runtime.supervisorOp({ op: 'writeFile', args: ['/home/user/app/out/a.txt', 'a'], pid: server.pid });
    assert.deepEqual([...new Set([...at('/home/user/app/out'), ...at('/home/user/app/out/a.txt')])], ['h1'], JSON.stringify(events.slice(-4)));
  });

  await check('its strict write batch', async () => {
    const now = Date.now();
    await runtime.supervisorOp({
      op: 'writeBatch',
      args: [{
        inodes: [{ path: 'home/user/app/out/batch.txt', parentPath: 'home/user/app/out', kind: 'file', isDir: false, size: 1, mtime: now, mode: 0o644, chunkCount: 1 }],
        chunks: [{ path: 'home/user/app/out/batch.txt', chunkId: 0, data: new Uint8Array([0x62]) }],
      }],
      pid: server.pid,
    });
    const ids = at('/home/user/app/out/batch.txt');
    assert.ok(ids.length > 0, `the batch was observed: ${JSON.stringify(events.slice(-4))}`);
    assert.deepEqual([...new Set(ids)], ['h1']);
  });

  await check('a KV put its server\'s Worker makes', async () => {
    const before = events.length;
    await runtime.supervisorOp({
      op: 'kvCall',
      args: [{ root: '/home/user/app', store: 'CACHE', writer: server.pid }, { method: 'put', key: 'k', value: 'v' }],
      cred: bundle.CRED_SESSION_USER,
    });
    const put = events.slice(before).filter((event) => event.path.startsWith('/home/user/app/.nimbus/kv/'));
    assert.ok(put.length > 0, `the put was observed: ${JSON.stringify(events.slice(before))}`);
    assert.deepEqual([...new Set(put.map((event) => event.execId))], ['h1']);
  });
} finally {
  await runtime.close?.();
}

assert.deepEqual(failures, []);
console.log('write-attribution-hosted: a hosted program\'s writes name its exec; the session\'s own name none');
process.exit(0);
