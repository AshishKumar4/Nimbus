#!/usr/bin/env bun
// A launch waiting for a worker of its own session does not hold another
// session's launch in its preparation. Sessions share an isolate, and with it
// the supervisor's transient budget, which a launch's build is admitted on.
//
// Red before: the waiting launch kept its build's admission while it waited
// for a worker, and a build in another session asks for the whole budget, so
// that session's command waited, unprepared, for as long as the first
// session's workers were busy.
import assert from 'node:assert/strict';
import { beginLoaderFetch, DO_DYNAMIC_WORKER_LIMIT } from '../../packages/fabric/src/budgets.ts';
import { readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';
import { createAuthority } from './lib/resident-body.mjs';

const authority = createAuthority();
adoptSessionSupervisor(authority.host, () => {});
const session = (name) => {
  const ctx = createFacetCtx(createFacetWorld(() => ({})), name);
  return { ctx, manager: oneShotManager(name, { host: authority.host, rawVfs: authority.rawVfs, loader: runnerLoader(name), ctx }) };
};
const busy = session('credit-busy');
const other = session('credit-other');
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// Every worker of the busy session held: its launch prepares, then waits for one.
const holds = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(busy.ctx, `resident-${i}`));
const waiting = busy.manager.exec('process.stdout.write("busy\\n")', { cwd: '/home/user', captureOutput: true });
const deadline = Date.now() + 30_000;
while (busy.manager.launchState().launches[0]?.stage !== 'admission') {
  assert.ok(Date.now() < deadline, `the busy session's launch reached admission: ${JSON.stringify(busy.manager.launchState())}`);
  await settle();
}

// The other session's command runs meanwhile.
const ran = other.manager.exec('process.stdout.write("other\\n")', { cwd: '/home/user/app', captureOutput: true });
const outcome = await Promise.race([ran, new Promise((resolve) => setTimeout(() => resolve(null), 20_000))]);
assert.ok(outcome !== null, `the other session's command ran while the busy one waited for a worker; it waits at ${JSON.stringify(other.manager.launchState())}, the budget ${JSON.stringify(readSupervisorAllocationBudget())}`);
assert.equal(outcome.exitCode, 0, outcome.stderr);
assert.equal(outcome.stdout, 'other\n');

// Let in, the busy session's launch runs too.
holds[0]();
const result = await waiting;
assert.equal(result.exitCode, 0, result.stderr);
assert.equal(result.stdout, 'busy\n');
for (const end of holds.slice(1)) end();
console.log("launch-credit-across-sessions: a launch waiting for its session's worker holds no other session's launch");
