#!/usr/bin/env bun
// @serial
// A launch of a program already built (a cache hit, no build of its own)
// generates its module map as its facet loads, its run holding the launch's
// Dynamic Worker (claimAdmission). Its share of the supervisor's transient
// budget is taken before it takes that worker (the lock order, Kinu #29):
// under another build's full reservation it waits holding no worker, and
// runs once the room is given back. Taken inside the load, the wait held the
// worker, and giving it back there failed the launch instead
// (InternalScallop's trace at 8ec94530).

import assert from 'node:assert/strict';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { DO_DYNAMIC_WORKER_LIMIT, dynamicWorkerHeadroom } from '../../packages/fabric/src/budgets.ts';
import { acquireSupervisorAllocation, readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES } from '../../packages/platform/src/limits.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
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
const ctx = createFacetCtx(world, 'contended-cache-hit-admission');
const env = {
  LOADER: {
    load() {
      return {
        getEntrypoint: () => ({ async run() { return Response.json({ exitCode: 0, stdout: '', stderr: '' }); }, [Symbol.dispose]() {} }),
        [Symbol.dispose]() {},
      };
    },
    get: world.loader.get.bind(world.loader),
  },
  ASSETS: stagedAssets,
};
const manager = new FacetManager(
  ctx, env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor,
  { requestLaunchTurn: () => { setTimeout(() => { void manager.pumpResidentLaunches(); }, 0); }, onExternalExit: () => {} },
);
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(vfs, processFiles(vfs));
const fs = vfs.as(CRED_KERNEL);
fs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
// Its map's share is past the pool's small-request reserve (CHUNK_SIZE), so it waits on the budget itself.
fs.writeFile('home/user/app/job.js', `module.exports = ${JSON.stringify('j'.repeat(512 * 1024))}.length;\n`, { mode: 0o644 });

const budget = () => readSupervisorAllocationBudget();
const run = () => manager.exec("require('./job.js');", { filename: '/home/user/app/run.js', cwd: '/home/user/app', captureOutput: true });

// Built once: the next launch of it is a cache hit.
assert.equal((await run()).exitCode, 0, 'the first launch builds and runs');
assert.equal(budget().current, 0, 'and gives its credit back');

// Another build's full reservation.
const other = await acquireSupervisorAllocation(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES);
const hit = run();
let settled = false;
hit.then(() => { settled = true; }, () => { settled = true; });
for (let i = 0; i < 400 && budget().queued < 1 && !settled; i++) await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(settled, false, `the cache hit waits for room (${JSON.stringify(budget())})`);
assert.equal(budget().queued, 1, `the cache hit is queued for credit (${JSON.stringify(budget())})`);
assert.equal(dynamicWorkerHeadroom(ctx), DO_DYNAMIC_WORKER_LIMIT, 'and holds no worker while it waits');

other.release();
const result = await Promise.race([hit, new Promise((_, reject) => setTimeout(() => reject(new Error('the cache hit did not run once room was given back')), 20_000))]);
assert.equal(result.exitCode, 0, `the cache hit runs once room is given back: ${result.stderr}`);
assert.equal(budget().current, 0, 'and gives its credit back');
console.log('contended-cache-hit-admission: OK');
process.exit(0);
