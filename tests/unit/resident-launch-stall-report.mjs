#!/usr/bin/env bun
// @serial
// A resident that waits for credit leaves the same single named-owner
// report as a one-shot; killed launches leave no later timer behind.
import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { acquireSupervisorAllocation, readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { launchManager } from './lib/facet-launch-harness.mjs';
import { until } from './lib/resident-body.mjs';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });
let pid;
const h = launchManager('resident-stall', { hooks: { onSpawn: (spawned) => { pid = spawned; } } });
const fs = h.vfs.as(CRED_KERNEL);
fs.mkdir('home/user/resident', { recursive: true, mode: 0o755 });
fs.writeFile('home/user/resident/cell.js', 'module.exports=1;', { mode: 0o644 });
const held = await acquireSupervisorAllocation(readSupervisorAllocationBudget().capacity, undefined,
  { owner: 'known allocator blocking resident', pid: 99, session: 'holder-session' });
const reports = [];
const warn = console.warn;
console.warn = (...args) => {
  const line = args.join(' ');
  if (line.startsWith('[facet-manager] launch stalled: ')) reports.push(JSON.parse(line.slice('[facet-manager] launch stalled: '.length)));
  else warn(...args);
};
const spawn = () => h.manager.spawnNode('require("./cell.js");', {
  filename: '/home/user/resident/run.js', cwd: '/home/user/resident', command: 'node run.js --host',
});
let resident;
try {
  const killed = spawn();
  await until(() => readSupervisorAllocationBudget().queued === 1, 'the first resident waits on credit');
  const killedPid = pid;
  h.manager.kill(killedPid);
  await killed.catch(() => {});
  pid = undefined;
  resident = spawn();
  await until(() => readSupervisorAllocationBudget().queued === 1, 'the resident waits with no worker');
  const waitingPid = pid;
  await new Promise((resolve) => setTimeout(resolve, 10_500));
  assert.equal(reports.length, 1, `one live resident leaves one report: ${JSON.stringify(reports)}`);
  assert.equal(reports[0].pid, waitingPid);
  assert.equal(reports[0].stage, 'prepare');
  assert.equal(reports[0].ledger.inFlight, 0);
  assert.equal(reports[0].ledger.waiting, 0);
  assert.ok(reports[0].budget.holders.some((owner) => owner.owner === 'known allocator blocking resident'));
  assert.ok(reports[0].budget.waiting.some((owner) => owner.pid === waitingPid));
  assert.ok(!reports.some((report) => report.pid === killedPid));
  h.manager.kill(waitingPid);
  await resident.catch(() => {});
  assert.deepEqual(h.manager.launchState().launches, []);
} finally {
  console.warn = warn;
  held.release();
  if (pid !== undefined) h.manager.kill(pid);
  if (resident) await resident.catch(() => {});
}
console.log('resident-launch-stall-report: a stalled resident names its allocation holder, once');
