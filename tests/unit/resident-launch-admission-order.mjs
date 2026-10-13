#!/usr/bin/env bun
// @serial
// A launch never waits for the supervisor's transient budget holding a
// Dynamic Worker (Kinu #29). InternalScallop's cycle: a standalone resident
// (no launch admission) took the whole budget until it had measured its
// closure, then its module pass asked the ledger for the transform helper's
// worker (beginHelperFetch), while ten exec launches, let in on every worker
// (withLaunchAdmission), waited for its credit. Each waited on the other for
// good, and the ledger, which models only child waits, saw no deadlock. An
// exec waiting for room now gives its worker back and takes it again once
// it has room, credit before worker, as the resident's build takes them.
// Here the resident's transform host (as the real one, oxcTransformHost)
// brackets its call with beginHelperFetch; once the ten execs wait for
// credit, the cycle either resolves (every launch finishes) or it does not.

import assert from 'node:assert/strict';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { DO_DYNAMIC_WORKER_LIMIT, beginHelperFetch, dynamicWorkerHeadroom } from '../../packages/fabric/src/budgets.ts';
import { readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
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
const ctx = createFacetCtx(world, 'resident-launch-admission-order');
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
// The transform host as the real one is: one worker in flight on the ledger for
// each call (beginHelperFetch), held back until the execs wait.
let openGate;
const gate = new Promise((resolve) => { openGate = resolve; });
let transforms = 0;
manager.setEsbuildService(new EsbuildService(undefined, {
  transformHost: async (requests) => {
    await gate;
    const end = await beginHelperFetch(ctx, 'transform-helper');
    try {
      transforms++;
      return requests.map(({ code }) => ({ code, map: '', warnings: [] }));
    } finally {
      end();
    }
  },
}));
const fs = vfs.as(CRED_KERNEL);
fs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
fs.writeFile('home/user/app/server.mjs', 'export const port = 3000;\n', { mode: 0o644 });
for (let i = 0; i < DO_DYNAMIC_WORKER_LIMIT; i++) fs.writeFile(`home/user/app/job${i}.js`, `module.exports = ${i};\n`, { mode: 0o644 });

const budget = () => readSupervisorAllocationBudget();
const until = async (ok, label) => {
  for (let i = 0; i < 2000 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ok(), label);
};

// The resident's build is admitted to the budget and reaches its module pass.
const resident = manager.spawnNode("require('./server.mjs');", { filename: '/home/user/app/run.js', cwd: '/home/user/app', command: 'node run.js' });
await until(() => budget().current > 0, `the resident's build holds credit (${JSON.stringify(budget())})`);
// Ten exec launches at once, each let in on a worker, then waiting for the resident's credit.
const execs = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) =>
  manager.exec(`require('./job${i}.js');`, { filename: `/home/user/app/job-run${i}.js`, cwd: '/home/user/app', captureOutput: true }));
await until(() => budget().queued >= DO_DYNAMIC_WORKER_LIMIT,
  `the ten execs queued for credit (${JSON.stringify(budget())}, headroom ${dynamicWorkerHeadroom(ctx)})`);
// The resident's module pass asks for its transform helper's worker.
openGate();
const outcome = await Promise.race([
  Promise.allSettled([resident, ...execs]),
  new Promise((resolve) => setTimeout(() => resolve('deadlocked'), 20_000)),
]);
assert.notEqual(outcome, 'deadlocked', `the resident's build and the ten execs all finish (${JSON.stringify(budget())}, headroom ${dynamicWorkerHeadroom(ctx)}, ${transforms} transforms)`);
for (const [i, result] of outcome.entries()) {
  assert.equal(result.status, 'fulfilled', `${i === 0 ? 'the resident' : `exec ${i - 1}`}: ${result.status === 'rejected' ? result.reason?.stack ?? result.reason : ''}`);
}
assert.ok(transforms > 0, 'the resident\'s module pass ran on its helper');
assert.equal(budget().current, 0, 'every launch gave its credit back');
manager.kill(outcome[0].value.pid);
console.log('resident-launch-admission-order: OK');
process.exit(0);
