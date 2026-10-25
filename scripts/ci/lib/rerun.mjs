// The rerun rule (the user's decision, 2026-10-24): a red probe row is run
// once more, alone (a job of its own, one after another, the probe alone in
// it), on the same deployed target, and that run grades it. A one-off red,
// where a session or a Preview landed, passes; a real red fails twice. It
// holds wherever probes are graded: a train's run and the release matrix are
// both remote-probes runs, and lib/matrix.mjs grades a rerun row by its rerun.
//
// A paired perf probe runs on Previews of its own, which a run again replaces
// with a fresh set: its red is confirmed on a fresh set, which grades its
// first row, and a confirmed red is run once more on one more fresh set,
// which grades it. A real +50-60% fails all three sets; a set slower by where
// it landed rarely lands so twice more (2026-10-24: a false CONFIRMED in
// train 1024a).
//
// Not rerun:
// - a probe the release record defers: its deferral grades its red
//   (tests/behavioral/_deferred.mjs);
// - the session ledger, which is no probe;
// - a row that did not grade (exit 2);
// - a row something already ran again (`regraded`), and a rerun's own row: once.
//
// The verdict keeps both: the first row, marked `regraded` with the rerun's
// task, its armada job and the first red's detail, and the rerun's task with
// its rows.
import { completedAssertions } from '../../../tests/behavioral/_assertions.mjs';

const PROBE = /^tests\/behavioral\/(.+)\.mjs$/;

/** A row's probe (`tests/behavioral/a/b.mjs` → `a/b`), or null for a row that is none (the session ledger, a run that did not start). */
const probeOf = (row) => PROBE.exec(row.name)?.[1] ?? null;

/** The red rows of `tasks` (a run's first tasks) the rule runs again, each with its task. */
function redRows(tasks, own) {
  return tasks.flatMap((task) => (task.rows ?? [])
    .filter((row) => row.exitCode !== 0 && row.exitCode !== 2 && !row.regraded)
    .filter((row) => probeOf(row) !== null && !own.has(probeOf(row)))
    .map((row) => ({ task, row })));
}

/** What the first red said: its exit, each failed check's first line, and its output's last lines. */
function firstRed(row) {
  const checks = completedAssertions(row.assertions);
  return {
    exitCode: row.exitCode,
    ...(checks ? { failed: checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail.split('\n')[0].slice(0, 300)}`) } : {}),
    tail: row.output.trimEnd().split('\n').slice(-12).join('\n'),
  };
}

/**
 * `reds` run again by `runner`, which maps `items` on armada and resolves to
 * `{ tasks, problems }`, each task as it read it: with its rows and the
 * armada `job` that produced them. `taskOf(i)` is the index in `items` of the
 * task that runs `reds[i]` again. Each row whose task holds that probe's row
 * is marked `regraded` with the task, its job and the first red's detail;
 * one that holds none is a problem: the run is not graded. Resolves to the
 * rows the second runs gave, in the order of `reds`, the problems and one
 * line per row.
 */
async function runAgain(tasks, reds, items, taskOf, runner, said) {
  const again = await runner(items);
  tasks.push(...again.tasks);
  const problems = [...again.problems];
  const seconds = [];
  const lines = reds.map(({ row }, i) => {
    const task = again.tasks[taskOf(i)];
    const second = task?.rows?.find((other) => other.name === row.name);
    if (!second) {
      problems.push(`${items[taskOf(i)].task} has no row of ${row.name}`);
      return `RERUN ${row.name}: ${items[taskOf(i)].task} has no row of it; not graded`;
    }
    row.regraded = { task: task.task, job: task.job, first: firstRed(row) };
    seconds.push({ task, row: second });
    return `RERUN ${row.name}: red, then ${second.exitCode === 0 ? 'green' : `red again (exit ${second.exitCode})`} ${said} (${task.task}, job ${task.job})`;
  });
  return { seconds, problems, lines };
}

/** `outcome`'s problems and lines added to `result`. */
const merge = (result, outcome) => {
  result.problems.push(...outcome.problems);
  result.lines.push(...outcome.lines);
};

/** The paired probes of `reds` in one task, to run on a fresh set of Previews. */
const pairedTask = (reds, task) => [{ task, part: '1/1', only: [...new Set(reds.map(({ row }) => `${probeOf(row)}.mjs`))].join(','), skip: '', jobs: 1 }];

/**
 * The rule on a run's first `tasks`: each red row is run again, and that run
 * grades it. A probe that is not paired runs alone, by a `run` of its own once
 * the one before it has ended, on the same target: run together, reruns of
 * load-sensitive probes failed each other (2026-10-25, large-install beside
 * eleven others, green alone). A paired probe's reds run in one task on a fresh
 * set of Previews, by `runPaired`, which confirms them; each red there (a
 * confirmed red) runs once more on one more fresh set, which grades it. `run`
 * and `runPaired` resolve to `{ tasks, problems }` for the items they are
 * given, in their order, each task with its armada `job`. The tasks they ran
 * join `tasks`. `paired` names the paired probes and `deferred` the probes
 * whose deferral grades them. Resolves to the problems (a run that left a red
 * ungraded) and one line per row run again.
 */
export async function rerunRed(tasks, { paired, deferred, run, runPaired }) {
  const reds = redRows(tasks, new Set(deferred));
  const pairedProbes = new Set(paired);
  const plain = reds.filter(({ row }) => !pairedProbes.has(probeOf(row)));
  const pairedReds = reds.filter(({ row }) => pairedProbes.has(probeOf(row)));
  const result = { problems: [], lines: [] };
  for (const [i, red] of plain.entries()) {
    const items = [{ task: `rerun ${probeOf(red.row)} #${i + 1}`, part: '1/1', only: `${probeOf(red.row)}.mjs`, skip: '', jobs: 1 }];
    merge(result, await runAgain(tasks, [red], items, () => 0, run, 'alone on the same target'));
  }
  if (pairedReds.length > 0) {
    const items = pairedTask(pairedReds, 'paired perf on fresh Previews');
    const confirmation = await runAgain(tasks, pairedReds, items, () => 0, runPaired, 'on a fresh set of Previews');
    merge(result, confirmation);
    const confirmed = confirmation.seconds.filter(({ row }) => row.exitCode !== 0 && row.exitCode !== 2);
    if (confirmed.length > 0) {
      merge(result, await runAgain(tasks, confirmed, pairedTask(confirmed, 'paired perf rerun on fresh Previews'), () => 0, runPaired, 'on one more fresh set of Previews'));
    }
  }
  return result;
}

/**
 * A run's grade from its tasks: 2 when a task did not grade or a row it
 * grades is exit 2, else 1 when a row is red, else 0. A row its rerun
 * grades counts as its rerun's row does.
 */
export function gradeTasks(tasks) {
  let status = 0;
  for (const task of tasks) {
    if (!task.rows || task.screenshotError) return 2;
    const red = task.rows.filter((row) => row.exitCode !== 0 && !row.regraded);
    if (red.some((row) => row.exitCode === 2)) status = 2;
    else if (red.length > 0 && status === 0) status = 1;
  }
  return status;
}
