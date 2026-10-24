#!/usr/bin/env bun
// scripts/ci/lib/rerun.mjs: a red probe row is run once more, alone, on the
// same deployed target, and that run grades it, in a train's run and in the
// release matrix (lib/matrix.mjs grades a remote-probes verdict).
// - A one-off red that passes on its rerun is green.
// - A real red fails twice and is red, by its rerun's row.
// - A paired probe (confirmed on fresh Previews instead), a deferred probe
//   (graded by its deferral), the session ledger and a row that did not
//   grade are not run again, and a rerun's own red is not run a third time.
// - The verdict keeps the first red's detail and the rerun's task and job.
import assert from 'node:assert/strict';
import { gradeTasks, rerunRed } from '../../scripts/ci/lib/rerun.mjs';
import { gradeMatrix } from '../../scripts/ci/lib/matrix.mjs';

/** A probe's row: green, or red with one failed check; `exitCode` 2 did not grade. */
const row = (probe, exitCode, detail = 'expected 3, got 4') => ({
  name: `tests/behavioral/${probe}.mjs`, exitCode, seconds: 1, output: `  ✗ step — ${detail}\n`,
  assertions: [{ id: 1, label: probe, complete: true, checks: [{ name: 'step', ok: exitCode === 0, detail: exitCode === 0 ? '' : detail }] }],
});
const ledger = (exitCode) => ({ name: 'session-ledger', exitCode, seconds: 0, output: '' });

/**
 * A rerun runner: each item's task holds its probe's row, green when the
 * probe is in `passes`, and a green ledger. It records what it was asked to run.
 */
function runner(passes) {
  const asked = [];
  const run = async (items) => {
    asked.push(items);
    return {
      jobId: `job-rerun-${asked.length}`,
      problems: [],
      tasks: items.map((item) => ({ ...item, rows: [row(item.only.replace(/\.mjs$/, ''), passes.includes(item.only.replace(/\.mjs$/, '')) ? 0 : 1, 'still 4'), ledger(0)] })),
    };
  };
  return { asked, run };
}

const PAIRED = ['perf-regression/cold-start'];
const DEFERRED = ['x/deferred'];

// A one-off red that passes on rerun: the run is green.
{
  const tasks = [{ task: 'part 1/4', rows: [row('a/once', 1, 'socket closed'), row('a/fine', 0), ledger(0)] }];
  const { asked, run } = runner(['a/once']);
  const { lines } = await rerunRed(tasks, { paired: PAIRED, deferred: DEFERRED, run });
  assert.deepEqual(asked.map((items) => items.map((item) => [item.only, item.jobs])), [[['a/once.mjs', 1]]], 'only the red probe runs again, alone');
  assert.equal(gradeTasks(tasks), 0, 'its rerun passed: the run is green');
  assert.equal(gradeMatrix([{ problems: [], tasks }], []).exitCode, 0, 'and so is the release matrix');
  const first = tasks[0].rows[0];
  assert.deepEqual(first.regraded, {
    task: 'rerun a/once #1', job: 'job-rerun-1',
    first: { exitCode: 1, failed: ['step: socket closed'], tail: '  ✗ step — socket closed' },
  }, 'the verdict keeps the first red, and which task and job graded it');
  assert.match(lines[0], /RERUN tests\/behavioral\/a\/once\.mjs: red, then green alone on the same target \(rerun a\/once #1, job job-rerun-1\)/);
}

// A real red fails twice: red, by its rerun's row; a one-off beside it is green.
{
  const tasks = [{ task: 'part 2/4', rows: [row('b/real', 1), row('b/once', 1), ledger(0)] }];
  const { asked, run } = runner(['b/once']);
  await rerunRed(tasks, { paired: PAIRED, deferred: DEFERRED, run });
  assert.equal(asked.length, 1, 'one rerun job');
  assert.equal(gradeTasks(tasks), 1, 'a red that fails twice is red');
  const graded = gradeMatrix([{ problems: [], tasks }], []);
  assert.equal(graded.exitCode, 1);
  assert.deepEqual(graded.red, ['tests/behavioral/b/real.mjs (rerun b/real #1, exit 1)'], 'the matrix names the real red by its rerun, and not the one-off');
}

// What is graded its own way, or is no probe, is not run again; a rerun's red is run once.
{
  const tasks = [
    { task: 'part 3/4', rows: [row('perf-regression/cold-start', 1), row('x/deferred', 1), row('c/not-graded', 2), ledger(1), row('c/real', 1)] },
  ];
  const { asked, run } = runner([]);
  await rerunRed(tasks, { paired: PAIRED, deferred: DEFERRED, run });
  assert.deepEqual(asked.map((items) => items.map((item) => item.only)), [['c/real.mjs']], 'a paired, a deferred, a not-graded row and the ledger are not run again');
  const rerunOwn = tasks.at(-1).rows[0];
  assert.equal(rerunOwn.exitCode, 1);
  assert.equal(rerunOwn.regraded, undefined, 'the rerun\'s red is the grade: not run a third time');
  assert.equal(gradeTasks(tasks), 2, 'a row that did not grade leaves the run not graded');
}

// A rerun task that holds no row of its probe leaves the first red standing.
{
  const tasks = [{ task: 'part 4/4', rows: [row('d/red', 1)] }];
  const run = async (items) => ({ jobId: 'job-empty', problems: [], tasks: items.map((item) => ({ ...item, rows: [ledger(0)] })) });
  const { lines } = await rerunRed(tasks, { paired: PAIRED, deferred: DEFERRED, run });
  assert.equal(tasks[0].rows[0].regraded, undefined);
  assert.equal(gradeTasks(tasks), 1);
  assert.match(lines[0], /has no row of it; the first red stands/);
}

console.log('ci-rerun-rule: ok');
