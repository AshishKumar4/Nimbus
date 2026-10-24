#!/usr/bin/env bun
// scripts/ci/lib/rerun.mjs: a red probe row is run once more, alone, on the
// same deployed target, and that run grades it, in a train's run and in the
// release matrix (lib/matrix.mjs grades a remote-probes verdict).
// - A one-off red that passes on its rerun is green.
// - A real red fails twice and is red, by its rerun's row.
// - A paired probe's confirmed red (red on two sets of Previews, the second
//   grading the first) is run once more on one more fresh set, which grades
//   it; the paired probes go in one task there.
// - A deferred probe (graded by its deferral), the session ledger and a row
//   that did not grade are not run again, and a rerun's own red is not run
//   again.
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
 * A rerun runner: each item's task holds a row of each probe it names, green
 * when the probe is in `passes`, and a green ledger. It records what it was
 * asked to run.
 */
function runner(passes, job = 'job-rerun') {
  const asked = [];
  const run = async (items) => {
    asked.push(items);
    return {
      jobId: `${job}-${asked.length}`,
      problems: [],
      tasks: items.map((item) => ({ ...item, rows: [...item.only.split(',').map((only) => row(only.replace(/\.mjs$/, ''), passes.includes(only.replace(/\.mjs$/, '')) ? 0 : 1, 'still 4')), ledger(0)] })),
    };
  };
  return { asked, run };
}
/** No paired rerun is asked for in a case without a confirmed paired red. */
const noPaired = async () => assert.fail('no paired probe should run again');
/** A paired probe runs again on fresh Previews, never on the same target. */
const notPlain = async () => assert.fail('a paired probe runs again on fresh Previews, not on the same target');

const PAIRED = ['perf-regression/cold-start'];
const DEFERRED = ['x/deferred'];

// A one-off red that passes on rerun: the run is green.
{
  const tasks = [{ task: 'part 1/4', rows: [row('a/once', 1, 'socket closed'), row('a/fine', 0), ledger(0)] }];
  const { asked, run } = runner(['a/once']);
  await rerunRed(tasks, { paired: PAIRED, deferred: DEFERRED, run, runPaired: noPaired });
  assert.deepEqual(asked.map((items) => items.map((item) => [item.only, item.jobs])), [[['a/once.mjs', 1]]], 'only the red probe runs again, alone');
  assert.equal(gradeTasks(tasks), 0, 'its rerun passed: the run is green');
  assert.equal(gradeMatrix([{ problems: [], tasks }], []).exitCode, 0, 'and so is the release matrix');
  const first = tasks[0].rows[0];
  assert.deepEqual(first.regraded, {
    task: 'rerun a/once #1', job: 'job-rerun-1',
    first: { exitCode: 1, failed: ['step: socket closed'], tail: '  ✗ step — socket closed' },
  }, 'the verdict keeps the first red, and which task and job graded it');
}

// A real red fails twice: red, by its rerun's row; a one-off beside it is green.
{
  const tasks = [{ task: 'part 2/4', rows: [row('b/real', 1), row('b/once', 1), ledger(0)] }];
  const { asked, run } = runner(['b/once']);
  await rerunRed(tasks, { paired: PAIRED, deferred: DEFERRED, run, runPaired: noPaired });
  assert.equal(asked.length, 1, 'one rerun job');
  assert.equal(gradeTasks(tasks), 1, 'a red that fails twice is red');
  const graded = gradeMatrix([{ problems: [], tasks }], []);
  assert.equal(graded.exitCode, 1);
  assert.deepEqual(graded.red, ['tests/behavioral/b/real.mjs (rerun b/real #1, exit 1)'], 'the matrix names the real red by its rerun, and not the one-off');
}

// What is graded its own way, or is no probe, is not run again; a rerun's red is run once.
{
  const tasks = [
    { task: 'part 3/4', rows: [row('x/deferred', 1), row('c/not-graded', 2), ledger(1), row('c/real', 1)] },
  ];
  const { asked, run } = runner([]);
  await rerunRed(tasks, { paired: PAIRED, deferred: DEFERRED, run, runPaired: noPaired });
  assert.deepEqual(asked.map((items) => items.map((item) => item.only)), [['c/real.mjs']], 'a deferred, a not-graded row and the ledger are not run again');
  const rerunOwn = tasks.at(-1).rows[0];
  assert.equal(rerunOwn.exitCode, 1);
  assert.equal(rerunOwn.regraded, undefined, 'the rerun\'s red is the grade: not run a third time');
  assert.equal(gradeTasks(tasks), 2, 'a row that did not grade leaves the run not graded');
}

// A rerun task that holds no row of its probe leaves the first red standing.
{
  const tasks = [{ task: 'part 4/4', rows: [row('d/red', 1)] }];
  const run = async (items) => ({ jobId: 'job-empty', problems: [], tasks: items.map((item) => ({ ...item, rows: [ledger(0)] })) });
  await rerunRed(tasks, { paired: PAIRED, deferred: DEFERRED, run, runPaired: noPaired });
  assert.equal(tasks[0].rows[0].regraded, undefined, 'no row of it in its rerun: the red stands');
  assert.equal(gradeTasks(tasks), 1);
}

// A paired probe: red on one set, red on a fresh set (which graded the first),
// then one more fresh set grades it. A real slowdown fails all three; a set
// that landed slow by chance passes the third.
const PAIRED_TWO = ['perf-regression/cold-start', 'perf-regression/clone-fast'];
/** A run whose paired probes were red on their first set and confirmed red on a fresh one. */
const confirmedRed = () => {
  const first = [row('perf-regression/cold-start', 1, 'slower'), row('perf-regression/clone-fast', 1, 'slower')];
  for (const red of first) red.regraded = { task: 'paired perf on fresh Previews', evidence: ['red on one set of Previews, then exit 1 on a fresh set'] };
  return [
    { task: 'paired perf', rows: [...first, ledger(0)] },
    { task: 'paired perf on fresh Previews', rows: [row('perf-regression/cold-start', 1, 'slower again'), row('perf-regression/clone-fast', 1, 'slower again'), ledger(0)] },
  ];
};
{
  const tasks = confirmedRed();
  const { asked, run } = runner(['perf-regression/cold-start'], 'job-paired');
  await rerunRed(tasks, { paired: PAIRED_TWO, deferred: DEFERRED, run: notPlain, runPaired: run });
  assert.deepEqual(asked, [[{ task: 'paired perf rerun on fresh Previews', part: '1/1', only: 'perf-regression/cold-start.mjs,perf-regression/clone-fast.mjs', skip: '', jobs: 1 }]],
    'the confirmed reds run once more, in one task on one more fresh set');
  assert.equal(tasks[1].rows[0].regraded.task, 'paired perf rerun on fresh Previews', 'the third set grades the confirmed red');
  assert.equal(tasks[1].rows[0].regraded.job, 'job-paired-1');
  assert.deepEqual(tasks[1].rows[0].regraded.first.failed, ['step: slower again']);
  assert.equal(gradeTasks(tasks), 1, 'a slowdown red on all three sets is red');
  const graded = gradeMatrix([{ problems: [], tasks }], []);
  assert.deepEqual(graded.red, ['tests/behavioral/perf-regression/clone-fast.mjs (paired perf rerun on fresh Previews, exit 1)'],
    'red by the third set; cold start, green there, is not');
}
{
  const tasks = confirmedRed();
  const { run } = runner(PAIRED_TWO, 'job-paired');
  await rerunRed(tasks, { paired: PAIRED_TWO, deferred: DEFERRED, run: notPlain, runPaired: run });
  assert.equal(gradeTasks(tasks), 0, 'confirmed reds that pass on the third set are green');
  assert.equal(gradeMatrix([{ problems: [], tasks }], []).exitCode, 0);
}

console.log('ci-rerun-rule: ok');
