#!/usr/bin/env bun
// @serial
// Every way into a resident's preparation follows the lock order (Kinu #29):
// its bundle and its credit before a Dynamic Worker. A resident is started in
// a launch admission it inherits in two ways, and gives that worker back
// while it prepares, taking it again for its boot, which claims it:
//   (1) brokered: a running program's child, let in on the ledger by the
//       broker (hosted/services.ts) before its command runs a server;
//   (2) promoted: an exec whose run stopped at its first listen, run on as a
//       resident (FacetManager._promote) inside the exec's admission.
// Each is started while another holder has the whole credit: its build
// waits for credit holding no worker, then boots once the credit is given
// back. Before, it waited for credit holding the inherited worker
// (InternalScallop, at 6583588af).

import assert from 'node:assert/strict';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { loaderLedgerStats, withLaunchAdmission } from '../../packages/fabric/src/budgets.ts';
import { acquireSupervisorAllocation, readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES } from '../../packages/platform/src/limits.ts';
import { STOP_RECORD_PREFIX } from '../../packages/worker/src/runtime/stop-replay-contracts.ts';
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
const ctx = createFacetCtx(world, 'resident-inherited-admission');
// A one-shot's run stops at its first listen once `listen` is opened.
let openListen;
const listening = new Promise((resolve) => { openListen = resolve; });
let runs = 0;
const TAPE = { seed: [1, 2, 3, 4], now: [], perf: [], random: '', reads: [], writes: [] };
const env = {
  LOADER: {
    load() {
      return {
        getEntrypoint: () => ({
          async run(request) {
            const { stopNonce } = await request.json();
            runs++;
            await listening;
            throw new Error(`${STOP_RECORD_PREFIX}${stopNonce} ${JSON.stringify({ v: 3, kind: 'listen', run: 1, out: [], tape: TAPE })}`);
          },
          [Symbol.dispose]() {},
        }),
        [Symbol.dispose]() {},
      };
    },
    get: world.loader.get.bind(world.loader),
  },
  ASSETS: stagedAssets,
};
const processes = new SessionProcessSupervisor();
const manager = new FacetManager(
  ctx, env, processes, new PortRegistry(), processHostFor,
  { requestLaunchTurn: () => { setTimeout(() => { void manager.pumpResidentLaunches(); }, 0); }, onExternalExit: () => {} },
);
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(vfs, processFiles(vfs));
const fs = vfs.as(CRED_KERNEL);
fs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
fs.writeFile('home/user/app/server.js', 'module.exports = 1;\n', { mode: 0o644 });
// Past the pool's small-request reserve (CHUNK_SIZE): a map made from it waits on the budget itself.
fs.writeFile('home/user/app/promoted.js', `module.exports = ${JSON.stringify('p'.repeat(512 * 1024))}.length;\n`, { mode: 0o644 });

const budget = () => readSupervisorAllocationBudget();
const launchHeld = (pid) => loaderLedgerStats(ctx).holders[`launch:${pid}`] ?? [];
const until = async (ok, label) => {
  for (let i = 0; i < 4000 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ok(), label);
};

// (1) Brokered: the child's admission is the broker's, taken before its command runs.
{
  const child = processes.spawn('node server.js', ['node', 'server.js'], '/home/user/app');
  const other = await acquireSupervisorAllocation(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES);
  const started = withLaunchAdmission(ctx, { pid: child.pid }, undefined, () => manager.spawnNode("require('./server.js');", {
    filename: '/home/user/app/server.js', cwd: '/home/user/app', command: 'node server.js', skipSpawn: true, callerPid: child.pid,
  }));
  await until(() => budget().queued >= 1, `the brokered resident's build waits for credit (${JSON.stringify(budget())})`);
  assert.deepEqual(launchHeld(child.pid), [], 'brokered: it waits for credit holding no worker');
  other.release();
  await until(() => launchHeld(child.pid).length > 0, 'brokered: it boots once the credit is given back, its residency on the launch\'s worker');
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('the brokered resident did not boot')), 20_000))]);
  manager.kill(child.pid);
}

// (2) Promoted: an exec's run stops at its first listen and runs on as a resident.
{
  const done = manager.exec("require('./promoted.js');", { filename: '/home/user/app/promoted.js', cwd: '/home/user/app', captureOutput: false });
  await until(() => runs === 1, 'the one-shot runs');
  const pid = Number(Object.keys(loaderLedgerStats(ctx).holders).find((key) => key.startsWith('launch:'))?.slice('launch:'.length));
  assert.ok(pid > 0, 'its launch holds its worker while it runs');
  // Its map is made: another holder takes the whole credit before it listens.
  const other = await acquireSupervisorAllocation(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES);
  openListen();
  await until(() => budget().queued >= 1, `the promoted resident's build waits for credit (${JSON.stringify(budget())})`);
  assert.deepEqual(launchHeld(pid), [], 'promoted: it waits for credit holding no worker');
  other.release();
  await until(() => launchHeld(pid).length > 0, 'promoted: it boots once the credit is given back, its residency on the launch\'s worker');
  manager.kill(pid);
  await Promise.race([done.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 20_000))]);
}

assert.equal(budget().current, 0, 'every launch gave its credit back');
console.log('resident-inherited-admission: OK');
process.exit(0);
