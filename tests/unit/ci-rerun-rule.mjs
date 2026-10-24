#!/usr/bin/env bun
// scripts/ci/lib/rerun.mjs: a red probe row is run once more, alone, on the
// same deployed target, and that run grades it, in a train's run and in the
// release matrix (lib/matrix.mjs grades a remote-probes verdict).
// - A one-off red that passes on its rerun is green.
// - A real red fails twice and is red, by its rerun's row.
// - A paired probe's red runs on a fresh set of Previews, which grades it; a
//   confirmed red runs once more on one more fresh set, which grades it.
//   The paired probes go in one task on each set.
// - Each link records the armada job that produced its grading row (a task
//   that started late ran in a job of its own), and a run again that holds
//   no row of its probe leaves the run not graded.
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
    const call = asked.length;
    const pass = typeof passes === 'function' ? passes(call) : passes;
    return {
      problems: [],
      // Each task as it was read, with the job that produced it: the last one started late, in a job of its own.
      tasks: items.map((item, i) => ({ ...item, job: i > 0 && i === items.length - 1 ? `${job}-${call}-late` : `${job}-${call}`,
        rows: [...item.only.split(',').map((only) => row(only.replace(/\.mjs$/, ''), pass.includes(only.replace(/\.mjs$/, '')) ? 0 : 1, 'still 4')), ledger(0)] })),
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
  assert.deepEqual(tasks[0].rows.slice(0, 2).map((red) => red.regraded.job), ['job-rerun-1', 'job-rerun-1-late'], 'each link names the job that produced its row');
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
  const run = async (items) => ({ problems: [], tasks: items.map((item) => ({ ...item, job: 'job-empty', rows: [ledger(0)] })) });
  const { problems } = await rerunRed(tasks, { paired: PAIRED, deferred: DEFERRED, run, runPaired: noPaired });
  assert.equal(tasks[0].rows[0].regraded, undefined, 'no row of it in its rerun: the red stands');
  assert.equal(problems.length, 1, 'and the run is not graded');
}

// A paired probe: red on its set, then on a fresh set (which grades the first
// row), then once more on one more fresh set, which grades the confirmed red.
const PAIRED_TWO = ['perf-regression/cold-start', 'perf-regression/clone-fast'];
/** A run whose paired probes were red on their first set. */
const pairedRed = () => [{ task: 'paired perf', rows: [row('perf-regression/cold-start', 1, 'slower'), row('perf-regression/clone-fast', 1, 'slower'), ledger(0)] }];
const BOTH = PAIRED_TWO.map((probe) => `${probe}.mjs`).join(',');
{
  const tasks = pairedRed();
  // The fresh set: both red again. One more: cold start green, clone red.
  const { asked, run } = runner((call) => (call === 1 ? [] : ['perf-regression/cold-start']), 'job-paired');
  await rerunRed(tasks, { paired: PAIRED_TWO, deferred: DEFERRED, run: notPlain, runPaired: run });
  assert.deepEqual(asked.map((items) => items.map((item) => [item.task, item.only])), [
    [['paired perf on fresh Previews', BOTH]],
    [['paired perf rerun on fresh Previews', BOTH]],
  ], 'confirmed on a fresh set, then once more on one more, the paired probes in one task each');
  assert.deepEqual(tasks[0].rows.slice(0, 2).map((red) => [red.regraded.task, red.regraded.job]),
    [['paired perf on fresh Previews', 'job-paired-1'], ['paired perf on fresh Previews', 'job-paired-1']], 'the fresh set grades the first rows');
  assert.deepEqual(tasks[1].rows.slice(0, 2).map((red) => [red.regraded.task, red.regraded.job, red.regraded.first.failed]),
    [['paired perf rerun on fresh Previews', 'job-paired-2', ['step: still 4']], ['paired perf rerun on fresh Previews', 'job-paired-2', ['step: still 4']]],
    'one more fresh set grades the confirmed reds');
  assert.equal(gradeTasks(tasks), 1, 'a slowdown red on all three sets is red');
  const graded = gradeMatrix([{ problems: [], tasks }], []);
  assert.deepEqual(graded.red, ['tests/behavioral/perf-regression/clone-fast.mjs (paired perf rerun on fresh Previews, exit 1)'],
    'red by the third set; cold start, green there, is not');
}
{
  // Green on the fresh set: no third set.
  const tasks = pairedRed();
  const { asked, run } = runner(PAIRED_TWO, 'job-paired');
  await rerunRed(tasks, { paired: PAIRED_TWO, deferred: DEFERRED, run: notPlain, runPaired: run });
  assert.equal(asked.length, 1, 'a red the fresh set does not confirm runs no third set');
  assert.equal(gradeTasks(tasks), 0);
  assert.equal(gradeMatrix([{ problems: [], tasks }], []).exitCode, 0);
}
{
  // Confirmed, then green on one more set: green.
  const tasks = pairedRed();
  const { run } = runner((call) => (call === 1 ? [] : PAIRED_TWO), 'job-paired');
  await rerunRed(tasks, { paired: PAIRED_TWO, deferred: DEFERRED, run: notPlain, runPaired: run });
  assert.equal(gradeTasks(tasks), 0, 'confirmed reds that pass on the third set are green');
  assert.equal(gradeMatrix([{ problems: [], tasks }], []).exitCode, 0);
}
{
  // A fresh set that holds no row of a probe confirms nothing: the run is not graded, and no third set runs for it.
  const tasks = pairedRed();
  const asked = [];
  const runPaired = async (items) => {
    asked.push(items);
    return { problems: [], tasks: items.map((item) => ({ ...item, job: 'job-paired-1', rows: [row('perf-regression/cold-start', 0), ledger(0)] })) };
  };
  const { problems } = await rerunRed(tasks, { paired: PAIRED_TWO, deferred: DEFERRED, run: notPlain, runPaired });
  assert.equal(asked.length, 1, 'no third set');
  assert.equal(problems.length, 1, 'the missing row leaves the run not graded');
  assert.equal(tasks[0].rows[1].regraded, undefined, 'and clone-fast\'s first red is not graded by a set that has no row of it');
}

console.log('ci-rerun-rule: ok');
