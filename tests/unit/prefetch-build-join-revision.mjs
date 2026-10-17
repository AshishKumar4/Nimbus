#!/usr/bin/env bun
// @serial
// A launch of a program another launch is building joins that build rather
// than building it again (prefetchBuilds), when both read the filesystem at
// one revision. A build that waited for credit reads the filesystem again
// once admitted and builds it as it is then: a launch arriving at that
// revision joins it. Before, the build stayed findable only at the revision
// it first read, so a launch at the newer one queued for credit and built
// the program a second time (InternalScallop's watermark ticket, #29).

import assert from 'node:assert/strict';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
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
const ctx = createFacetCtx(world, 'prefetch-build-join-revision');
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
// The build's module pass, held back while the second launch arrives.
let openGate;
const gate = new Promise((resolve) => { openGate = resolve; });
let transforms = 0;
manager.setEsbuildService(new EsbuildService(undefined, {
  transformHost: async (requests) => {
    transforms++;
    await gate;
    return requests.map(({ code }) => ({ code, map: '', warnings: [] }));
  },
}));
const fs = vfs.as(CRED_KERNEL);
fs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
fs.writeFile('home/user/app/mod.mjs', 'export const value = 1;\n', { mode: 0o644 });

const budget = () => readSupervisorAllocationBudget();
const until = async (ok, label) => {
  for (let i = 0; i < 4000 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ok(), label);
};
const launch = () => manager.exec("require('./mod.mjs');", { filename: '/home/user/app/run.js', cwd: '/home/user/app', captureOutput: true });

// The first launch's build waits for credit another holder has.
const other = await acquireSupervisorAllocation(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES);
const first = launch();
await until(() => budget().queued >= 1, `the first build waits for credit (${JSON.stringify(budget())})`);
// The filesystem moves on meanwhile; once admitted, the build reads it as it is then.
fs.writeFile('home/user/app/unrelated.txt', 'moved on\n', { mode: 0o644 });
other.release();
await until(() => transforms > 0, 'the first build reaches its module pass');

// A second launch of the program, at the revision the build reads.
const second = launch();
for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(budget().queued, 0, `the second launch joins the build in flight, not queueing for credit to build it again (${JSON.stringify(budget())})`);

openGate();
const results = await Promise.race([
  Promise.all([first, second]),
  new Promise((_, reject) => setTimeout(() => reject(new Error('the launches did not finish')), 20_000)),
]);
for (const result of results) assert.equal(result.exitCode, 0, result.stderr);
assert.equal(transforms, 1, 'the program was built once');
assert.equal(budget().current, 0, 'every launch gave its credit back');
console.log('prefetch-build-join-revision: OK');
process.exit(0);
