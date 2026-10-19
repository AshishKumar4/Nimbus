#!/usr/bin/env bun
// @serial
// The lock order across the supervisor's transient budget, in-flight builds
// and Dynamic Workers (Kinu #29): a launch takes credit, or joins another's
// build of its bundle, before it takes a worker, and holding a worker it
// waits on neither. InternalScallop's cycles: a standalone resident took the
// whole budget until it had measured its closure, then its module pass asked
// the ledger for the transform helper's worker (beginHelperFetch), while ten
// exec launches, each let in on a worker first, waited (1) for its credit,
// distinct programs, or (2) on its build, the same program as the
// resident's. Each waited on the other for good. Here the resident's
// transform host (as the real one, oxcTransformHost) brackets its call with
// beginHelperFetch, held back until the ten execs wait; then the cycle either
// resolves (every launch finishes) or it does not.

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
let gate;
const closeGate = () => { gate = new Promise((resolve) => { openGate = resolve; }); };
closeGate();
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
fs.writeFile('home/user/app/shared.mjs', 'export const shared = 1;\n', { mode: 0o644 });

const budget = () => readSupervisorAllocationBudget();
const until = async (ok, label) => {
  for (let i = 0; i < 2000 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ok(), label);
};

/** The resident and the ten execs all finish once the gate opens, and give every share back. */
const settles = async (label, resident, execs) => {
  openGate();
  const outcome = await Promise.race([
    Promise.allSettled([resident, ...execs]),
    new Promise((resolve) => setTimeout(() => resolve('deadlocked'), 20_000)),
  ]);
  assert.notEqual(outcome, 'deadlocked', `${label}: the resident's build and the ten execs all finish (${JSON.stringify(budget())}, headroom ${dynamicWorkerHeadroom(ctx)}, ${transforms} transforms)`);
  for (const [i, result] of outcome.entries()) {
    assert.equal(result.status, 'fulfilled', `${label}: ${i === 0 ? 'the resident' : `exec ${i - 1}`}: ${result.status === 'rejected' ? result.reason?.stack ?? result.reason : ''}`);
  }
  assert.ok(transforms > 0, `${label}: the resident's module pass ran on its helper`);
  assert.equal(budget().current, 0, `${label}: every launch gave its credit back`);
  manager.kill(outcome[0].value.pid);
};

// (1) Distinct programs: the ten wait for the resident's credit.
{
  const resident = manager.spawnNode("require('./server.mjs');", { filename: '/home/user/app/run.js', cwd: '/home/user/app', command: 'node run.js' });
  await until(() => budget().current > 0, `the resident's build holds credit (${JSON.stringify(budget())})`);
  const execs = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) =>
    manager.exec(`require('./job${i}.js');`, { filename: `/home/user/app/job-run${i}.js`, cwd: '/home/user/app', captureOutput: true }));
  await until(() => budget().queued >= DO_DYNAMIC_WORKER_LIMIT,
    `the ten execs queued for credit (${JSON.stringify(budget())}, headroom ${dynamicWorkerHeadroom(ctx)})`);
  await settles('distinct programs', resident, execs);
}

// (2) The same program: the ten join the resident's build of it.
{
  closeGate();
  transforms = 0;
  const same = { filename: '/home/user/app/shared-run.js', cwd: '/home/user/app' };
  const resident = manager.spawnNode("require('./shared.mjs');", { ...same, command: 'node shared-run.js' });
  await until(() => budget().current > 0, `the resident's build holds credit (${JSON.stringify(budget())})`);
  const execs = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, () => manager.exec("require('./shared.mjs');", { ...same, captureOutput: true }));
  // They join its build, which waits on no credit: given time to reach it.
  for (let i = 0; i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await settles('the same program', resident, execs);
}

console.log('resident-launch-admission-order: OK');
process.exit(0);
