// The rerun rule (the user's decision, 2026-10-24): a red probe row is run
// once more, alone (a task of its own, the probe alone in it), on the same
// deployed target, and that run grades it. A one-off red, where a session or
// a Preview landed, passes; a real red fails twice. It holds wherever probes
// are graded: a train's run and the release matrix are both remote-probes
// runs, and lib/matrix.mjs grades a rerun row by its rerun.
//
// A paired perf probe's red is first confirmed on a fresh set of Previews
// (remote-probes), which grades its first row. A confirmed red is then run
// once more under this rule, on one more fresh set, which grades it: a
// real +50-60% fails all three sets, and a slower set by where it landed
// rarely lands twice more (2026-10-24: a false CONFIRMED in train 1024a).
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
 * `reruns` run again by `runner`, which maps `items` on armada and resolves
 * to `{ tasks, jobId, problems }` in their order; `taskOf(i)` is the index in
 * `items` of the task that reruns `reruns[i]`. Each first row whose rerun task
 * holds that probe's row is marked `regraded` with the rerun's task, its job
 * and the first red's detail.
 */
async function runAgain(tasks, reruns, items, taskOf, runner, where) {
  const again = await runner(items);
  tasks.push(...again.tasks);
  const lines = reruns.map(({ row }, i) => {
    const item = items[taskOf(i)];
    const second = again.tasks[taskOf(i)]?.rows?.find((other) => other.name === row.name);
    if (!second) return `RERUN ${row.name}: its rerun (${item.task}) has no row of it; the red stands`;
    row.regraded = { task: item.task, job: again.jobId, first: firstRed(row) };
    return `RERUN ${row.name}: red, then ${second.exitCode === 0 ? 'green' : `red again (exit ${second.exitCode})`} ${where} (${item.task}, job ${again.jobId})`;
  });
  return { problems: again.problems, lines };
}

/**
 * The rule on a run's `tasks`, once the paired probes' confirmation has run:
 * each red row it reruns is run again and that run grades it. A probe that is
 * not paired runs alone in a task of its own, by `run`, on the same target; a
 * paired probe's confirmed red runs on one more fresh set of Previews, the
 * paired probes in one task, by `runPaired`. Each resolves to
 * `{ tasks, jobId, problems }` for the items it is given, in their order. The
 * rerun tasks join `tasks`. `paired` names the paired probes and `deferred` the
 * probes whose deferral grades them. Resolves to the problems and one line per rerun.
 */
export async function rerunRed(tasks, { paired, deferred, run, runPaired }) {
  const reds = redRows(tasks, new Set(deferred));
  const pairedProbes = new Set(paired);
  const plain = reds.filter(({ row }) => !pairedProbes.has(probeOf(row)));
  const confirmed = reds.filter(({ row }) => pairedProbes.has(probeOf(row)));
  const result = { problems: [], lines: [] };
  if (plain.length > 0) {
    const items = plain.map(({ row }, i) => ({ task: `rerun ${probeOf(row)} #${i + 1}`, part: '1/1', only: `${probeOf(row)}.mjs`, skip: '', jobs: 1 }));
    const outcome = await runAgain(tasks, plain, items, (i) => i, run, 'alone on the same target');
    result.problems.push(...outcome.problems);
    result.lines.push(...outcome.lines);
  }
  if (confirmed.length > 0) {
    const probes = [...new Set(confirmed.map(({ row }) => probeOf(row)))];
    const items = [{ task: 'paired perf rerun on fresh Previews', part: '1/1', only: probes.map((probe) => `${probe}.mjs`).join(','), skip: '', jobs: 1 }];
    const outcome = await runAgain(tasks, confirmed, items, () => 0, runPaired, 'on one more fresh set of Previews');
    result.problems.push(...outcome.problems);
    result.lines.push(...outcome.lines);
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
