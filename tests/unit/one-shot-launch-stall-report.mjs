#!/usr/bin/env bun
// @tier slow — waits out the 10 s a launch may stall at a stage before it says so
//
// A one-shot whose launch waits at one stage for 10 s says so once, in one
// line: its pid, its command, the stage, and the ledger's and the pacer's
// state. A user's command that hangs before it runs leaves nothing else
// behind; Workers Logs keeps this line. A launch that runs in time says
// nothing.
import assert from 'node:assert/strict';
import { beginLoaderFetch, DO_DYNAMIC_WORKER_LIMIT } from '../../packages/fabric/src/budgets.ts';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';
import { createAuthority } from './lib/resident-body.mjs';

const authority = createAuthority();
adoptSessionSupervisor(authority.host, () => {});
const ctx = createFacetCtx(createFacetWorld(() => ({})), 'launch-stall');
const manager = oneShotManager('launch-stall', { host: authority.host, rawVfs: authority.rawVfs, loader: runnerLoader('launch-stall'), ctx });

const reports = [];
const warn = console.warn;
console.warn = (...args) => {
  const line = args.join(' ');
  if (line.startsWith('[facet-manager] launch stalled: ')) reports.push(JSON.parse(line.slice('[facet-manager] launch stalled: '.length)));
  else warn(...args);
};
try {
  // With room, a run says nothing.
  const quick = await manager.exec('process.stdout.write("quick\\n")', { cwd: '/home/user', captureOutput: true });
  assert.equal(quick.exitCode, 0, quick.stderr);
  assert.deepEqual(reports, [], 'a launch that runs in time says nothing');

  // With every worker held, a run waits for admission, and says so once.
  const holds = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(ctx, `held-${i}`));
  const held = manager.exec('process.stdout.write("held\\n")', { cwd: '/home/user', captureOutput: true });
  while (manager.launchState().launches[0]?.stage !== 'admission') await new Promise((resolve) => setTimeout(resolve, 10));
  const [{ pid }] = manager.launchState().launches;
  await new Promise((resolve) => setTimeout(resolve, 10_500));
  assert.equal(reports.length, 1, `one line for the stalled launch: ${JSON.stringify(reports)}`);
  const [report] = reports;
  assert.deepEqual({ pid: report.pid, stage: report.stage }, { pid, stage: 'admission' });
  assert.ok(report.command.startsWith('node'), report.command);
  assert.ok(report.ms >= 10_000, `it waited the stall's length (${report.ms} ms)`);
  assert.deepEqual(report.ledger, { inFlight: DO_DYNAMIC_WORKER_LIMIT, waiting: 1, pauseMs: 0 }, 'with every worker held, and itself waiting');

  // Let in, it runs; its later stages say nothing more.
  holds[0]();
  const result = await held;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, 'held\n');
  assert.equal(reports.length, 1, 'and nothing after the one line');
  for (const end of holds.slice(1)) end();
} finally {
  console.warn = warn;
}
console.log('one-shot-launch-stall-report: a stalled launch says where, once');
