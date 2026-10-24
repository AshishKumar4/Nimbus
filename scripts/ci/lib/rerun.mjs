// The rerun rule (the user's decision, 2026-10-24): a red probe row is run
// once more, alone (a task of its own, the probe alone in it), on the same
// deployed target, and that run grades it. A one-off red, where a session or
// a Preview landed, passes; a real red fails twice. It holds wherever probes
// are graded: a train's run and the release matrix are both remote-probes
// runs, and lib/matrix.mjs grades a rerun row by its rerun.
//
// Not rerun, as their grading is their own:
// - a paired perf probe: a red set is confirmed on a fresh set of Previews
//   (remote-probes);
// - a probe the release record defers: its deferral grades its red
//   (tests/behavioral/_deferred.mjs);
// - the session ledger, which is no probe;
// - a row that did not grade (exit 2);
// - a rerun's own row: once.
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
 * The rule on a run's first `tasks`: each red row it reruns is run again by
 * `run` (remote-probes maps the items on armada, and resolves to
 * `{ tasks, jobId, problems }` in their order), each probe alone in a task of
 * its own. The rerun tasks join `tasks`, and each first row whose rerun task
 * holds that probe's row is marked `regraded` with the rerun's task, its job
 * and the first red's detail: its rerun grades it. `paired` and `deferred`
 * name the probes whose grading is their own. Resolves to the run's problems
 * and one line per rerun.
 */
export async function rerunRed(tasks, { paired, deferred, run }) {
  const reruns = redRows(tasks, new Set([...paired, ...deferred]));
  if (reruns.length === 0) return { problems: [], lines: [] };
  const items = reruns.map(({ row }, i) => ({ task: `rerun ${probeOf(row)} #${i + 1}`, part: '1/1', only: `${probeOf(row)}.mjs`, skip: '', jobs: 1 }));
  const again = await run(items);
  tasks.push(...again.tasks);
  const lines = reruns.map(({ row }, i) => {
    const second = again.tasks[i]?.rows?.find((other) => other.name === row.name);
    if (!second) return `RERUN ${row.name}: its rerun (${items[i].task}) has no row of it; the first red stands`;
    row.regraded = { task: items[i].task, job: again.jobId, first: firstRed(row) };
    return `RERUN ${row.name}: red, then ${second.exitCode === 0 ? 'green' : `red again (exit ${second.exitCode})`} alone on the same target (${items[i].task}, job ${again.jobId})`;
  });
  return { problems: again.problems, lines };
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
