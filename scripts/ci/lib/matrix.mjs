// How a release matrix is graded: from the rows of its remote-probes
// verdicts (scripts/ci/remote-probes.mjs writes them), against the user's
// record of deferred probes (tests/behavioral/_deferred.mjs).
//
// Green if and only if every task was graded, every red row is a deferred
// probe's own row, and every deferred probe ran and failed. A deferred probe
// that passes, or that did not run, is red: its deferral has ended, or no
// longer names anything. The session ledger and a not-graded task are never
// deferrable.

/** A row's probe, as _deferred.mjs names it: `tests/behavioral/a/b.mjs` → `a/b`. */
const probeOf = (name) => name.replace(/^tests\/behavioral\//, '').replace(/\.mjs$/, '');

/**
 * @param {Array<{ tasks: Array<{ task: string, outcome?: { kind: string }, rows: Array<{ name: string, exitCode: number, seconds: number, output: string }> | null }> } | null>} verdicts
 *   the matrix's remote-probes verdicts (null for one that wrote none)
 * @param {import('../../../tests/behavioral/_deferred.mjs').Deferral[]} deferred
 * @returns {{ exitCode: 0 | 1 | 2, red: string[], applied: Array<object>, problems: string[] }}
 *   exitCode 0 green, 1 red, 2 not graded; red, the red rows no deferral
 *   covers; applied, each deferral that covered red rows, with those rows;
 *   problems, every reason the matrix is not green.
 */
export function gradeMatrix(verdicts, deferred) {
  const problems = [];
  let notGraded = false;
  const rows = [];
  for (const verdict of verdicts) {
    if (!verdict) {
      notGraded = true;
      problems.push('a remote-probes run wrote no verdict');
      continue;
    }
    for (const task of verdict.tasks) {
      if (!task.rows) {
        notGraded = true;
        problems.push(`${task.task} was not graded (${task.outcome?.kind ?? 'no outcome'})`);
        continue;
      }
      for (const row of task.rows) rows.push({ ...row, task: task.task });
    }
  }
  for (const row of rows) {
    if (row.name === 'probes' && row.exitCode === 2) {
      notGraded = true;
      problems.push(`${row.task} was not graded: ${row.output.split('\n')[0]}`);
    }
  }

  const byProbe = new Map(deferred.map((entry) => [entry.probe, entry]));
  const red = [];
  const covered = new Map();
  for (const row of rows) {
    if (row.exitCode === 0 || (row.name === 'probes' && row.exitCode === 2)) continue;
    const entry = row.name.startsWith('tests/behavioral/') ? byProbe.get(probeOf(row.name)) : undefined;
    if (entry) {
      if (!covered.has(entry.probe)) covered.set(entry.probe, []);
      covered.get(entry.probe).push({ task: row.task, exitCode: row.exitCode, seconds: row.seconds, output: row.output });
    } else {
      red.push(`${row.name} (${row.task}, exit ${row.exitCode})`);
    }
  }
  if (red.length > 0) problems.push(`red: ${red.join('; ')}`);
  for (const entry of deferred) {
    const own = rows.filter((row) => row.name.startsWith('tests/behavioral/') && probeOf(row.name) === entry.probe);
    if (own.some((row) => row.exitCode === 0)) problems.push(`${entry.probe} passes; remove its deferral (tests/behavioral/_deferred.mjs)`);
    else if (own.length === 0 && !notGraded) problems.push(`${entry.probe} did not run; its deferral names nothing the matrix ran (tests/behavioral/_deferred.mjs)`);
  }
  const applied = deferred.filter((entry) => covered.has(entry.probe) && !rows.some((row) => probeOf(row.name) === entry.probe && row.exitCode === 0))
    .map((entry) => ({ ...entry, rows: covered.get(entry.probe) }));
  const exitCode = notGraded ? 2 : problems.length > 0 ? 1 : 0;
  return { exitCode, red, applied, problems };
}
