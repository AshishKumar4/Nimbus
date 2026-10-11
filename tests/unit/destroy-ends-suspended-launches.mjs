#!/usr/bin/env bun
// A destroy ends the launches suspended for a turn, and what they hold goes
// back to the isolate.
//
// A launch's build takes its share of the isolate's supervisor allocation
// credit (one pool, every session on the isolate) and, paced, waits between
// chunks for a turn the session's alarm grants. A destroy deletes that alarm
// and drops the manager: a build suspended when it lands never resumed, and
// its credit stayed taken for the isolate's life — the neighbours' launches
// and reads queued behind it. Red before: the pool stayed at two builds' worth
// after the destroy answered.

import assert from 'node:assert/strict';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { readSupervisorAllocationBudget, tryAcquireSupervisorAllocation } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { rpcDestroy } from '../../packages/worker/src/session/programmatic.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}));
const ctx = createFacetCtx(world, 'destroy-ends-suspended-launches');
const processes = new SessionProcessSupervisor();
const turns = { requested: 0 };
// The alarm that would grant the next turn has not fired when the destroy lands.
const manager = new FacetManager(
  ctx,
  { LOADER: world.loader, NIMBUS_LAUNCH_CHUNK_BYTES: '2048', ASSETS: stagedAssets },
  processes, new PortRegistry(), processHostFor,
  { requestLaunchTurn: () => { turns.requested++; }, onExternalExit: () => {} },
);
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(vfs, processFiles(vfs));

const fs = vfs.as(CRED_KERNEL);
fs.mkdir('home/user/node_modules/dep/lib', { recursive: true, mode: 0o755 });
fs.writeFile('home/user/node_modules/dep/package.json', JSON.stringify({ name: 'dep', main: 'lib/index.js' }), { mode: 0o644 });
fs.writeFile('home/user/node_modules/dep/lib/index.js',
  Array.from({ length: 40 }, (_, i) => `require('./mod${i}');`).join('\n') + '\nmodule.exports = 1;\n', { mode: 0o644 });
for (let i = 0; i < 40; i++) {
  fs.writeFile(`home/user/node_modules/dep/lib/mod${i}.js`, `module.exports = ${i};\n// ${'p'.repeat(400)}\n`, { mode: 0o644 });
}

const runs = ['/home/user/a.js', '/home/user/b.js'].map((filename) =>
  manager.exec("require('dep');", { filename, cwd: '/home/user', captureOutput: true })
    .then((result) => ({ result }), (error) => ({ error })));
for (let i = 0; i < 500 && (turns.requested < 2 || processes.getRunning().length < 2); i++) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.equal(turns.requested, 2, 'both builds suspended for a turn');
const held = readSupervisorAllocationBudget();
assert.ok(held.current > 0, `the suspended builds hold allocation credit (${JSON.stringify(held)})`);

const storage = new Map();
const host = {
  _w1SessionDestroyed: false,
  env: {},
  ctx: {
    getWebSockets: () => [],
    storage: {
      async get(k) { return storage.get(k); },
      async put(k, v) { storage.set(k, v); },
      async delete(k) { storage.delete(k); },
      async deleteAll() { storage.clear(); },
      async deleteAlarm() {},
    },
  },
  sqliteFs: vfs,
  processes,
  portRegistry: new PortRegistry(),
  facetManager: manager,
  shell: null,
  shellProcessPid: null,
  viteDevServer: null,
  cirrusReal: null,
  _cpRegistry: null,
  _viteShimPid: null,
  _viteShimPort: null,
  terminal: null,
  runtimeFsBridges: new Map(),
  ensureSqliteFs() {},
  ensureFacetManager() {},
  initSession() {},
};
const destroyed = await rpcDestroy(host, { reason: 'test' });
assert.equal(destroyed.ok, true);
assert.equal(destroyed.killed, 2);

const after = readSupervisorAllocationBudget();
assert.equal(after.current, 0, `the destroyed launches gave back their credit (${JSON.stringify(after)})`);
const whole = tryAcquireSupervisorAllocation(after.capacity);
assert.ok(whole !== null, 'the isolate\'s whole allocation budget is free again');
whole.release();

const settled = await Promise.race([
  Promise.all(runs),
  new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
]);
assert.ok(settled !== null, 'both destroyed launches ended');
for (const run of settled) assert.ok(run.error !== undefined, 'a destroyed launch never ran');
assert.equal(turns.requested, 2, 'no destroyed launch asked for another turn');

console.log('destroy-ends-suspended-launches: OK');
