// How a release matrix is graded: from the rows of its remote-probes
// verdicts (scripts/ci/remote-probes.mjs writes them), against the user's
// record of release exceptions (tests/behavioral/_deferred.mjs).
//
// Green if and only if every task was graded, every red row is a deferred
// probe's own row that failed exactly as approved (outcomeOf: it ran to its
// asserter's summary, its one named assertion failed, and every other
// assertion passed), and every deferred probe ran and failed. A deferred
// probe that passes, or that did not run, is red: its deferral has ended,
// or no longer names anything. The session ledger and a not-graded task are
// never deferrable or excludable (and _deferred.mjs refuses to list them).
// Excluded probes must not run; they are recorded and printed, not graded.
import { PROBE_TARGET_SKIPS } from '../../../tests/behavioral/_probe-target-skips.mjs';

/** A row's probe, as _deferred.mjs names it: `tests/behavioral/a/b.mjs` → `a/b`. */
const probeOf = (name) => name.replace(/^tests\/behavioral\//, '').replace(/\.mjs$/, '');

/** The release suite's selection: target-capability skips plus exclusions, including in requested repeats. */
export function matrixProbeArgs(entries, { repeat = '', times = '5' } = {}) {
  const excluded = entries.filter((entry) => entry.excluded === true).map((entry) => entry.probe);
  const excludedSelectors = new Set(excluded.flatMap((probe) => [probe, probe.split('/').at(-1)]));
  const repeated = repeat.split(',').filter((probe) => probe && !excludedSelectors.has(probeOf(probe))).join(',');
  return ['--target', 'staging', '--skip', [...PROBE_TARGET_SKIPS, ...excluded].join(','),
    ...(repeated ? ['--repeat', repeated, '--times', times] : [])];
}

/** The approved exception staging records, printed with the same information at release and promotion. */
export function describeReleaseException(entry) {
  const approval = `(approved ${entry.approved}; owner ${entry.owner}; tracking ${entry.tracking})`;
  if (entry.excluded === true) return `EXCLUDED ${entry.probe} — ${entry.reason} ${approval}`;
  return `DEFERRED ${entry.probe} — red in ${entry.rows.length} row${entry.rows.length === 1 ? '' : 's'}, shipped by deferral of ✗ ${entry.assertion} with ${JSON.stringify(entry.failure)} only: ${entry.reason} ${approval}`;
}

/**
 * What a probe's output says it asserted, structurally: makeAsserter
 * (_driver.mjs) prints each check as `  ✓ <label>` or `  ✗ <label> — <detail>`
 * on a line of its own, and, if the probe reached its end, a summary
 * `  ──── [<probe>] <pass> pass / <fail> fail`. The summary's counts are
 * read too, so a ✗ lost from a truncated output still counts.
 *
 * @param {string} output
 * @returns {{ finished: boolean, pass: number, fail: number, failed: Array<{ label: string, detail: string }> }}
 *   `detail`, the ✗ line's text after ` — ` (its first line only)
 */
export function outcomeOf(output) {
  const failed = [];
  for (const line of output.split('\n')) {
    const check = /^ {2}✗ (.*?)(?: — (.*))?$/.exec(line);
    if (check) failed.push({ label: check[1], detail: check[2] ?? '' });
  }
  const summary = [...output.matchAll(/^ {2}──── \[[^\]]*\] (\d+) pass \/ (\d+) fail$/gm)].at(-1);
  return { finished: summary !== undefined, pass: Number(summary?.[1] ?? 0), fail: Number(summary?.[2] ?? 0), failed };
}

/** Why a deferred probe's red row is not the failure its deferral allows, or null when it is. */
function beyondDeferral(row, entry) {
  const outcome = outcomeOf(row.output);
  if (!outcome.finished) return 'it did not reach its summary (an exception, or killed), so not every other assertion ran';
  const others = outcome.failed.filter((check) => check.label !== entry.assertion);
  if (others.length > 0) return `other assertions failed: ${others.map((check) => `✗ ${check.label}`).join('; ')}`;
  const pinned = outcome.failed.find((check) => check.label === entry.assertion);
  if (outcome.fail !== 1 || outcome.failed.length !== 1 || !pinned) {
    return `its summary says ${outcome.fail} failed, and the one deferrable is ✗ ${entry.assertion}${outcome.failed.length ? '' : ' (no ✗ line found)'}`;
  }
  if ('detail' in entry.failure) {
    const fragments = [entry.failure.detail].flat();
    return fragments.every((fragment) => pinned.detail.includes(fragment)) ? null
      : `it failed with ${JSON.stringify(pinned.detail.slice(0, 120))}, not the approved detail containing every fragment ${JSON.stringify(fragments)}`;
  }
  const http = /^HTTP (\d{3}): (.*)$/.exec(pinned.detail);
  const title = http ? /<title[^>]*>([^<]*)<\/title>/i.exec(http[2])?.[1] : undefined;
  if (Number(http?.[1]) !== entry.failure.status || title !== entry.failure.title) {
    return `it failed with ${http ? `HTTP ${http[1]}${title === undefined ? ' (no <title>)' : ` "${title}"`}` : JSON.stringify(pinned.detail.slice(0, 120))}, `
      + `not the approved HTTP ${entry.failure.status} "${entry.failure.title}"`;
  }
  return null;
}

/**
 * @param {Array<{ tasks: Array<{ task: string, outcome?: { kind: string }, rows: Array<{ name: string, exitCode: number, seconds: number, output: string }> | null }> } | null>} verdicts
 *   the matrix's remote-probes verdicts (null for one that wrote none)
 * @param {import('../../../tests/behavioral/_deferred.mjs').ReleaseException[]} deferred
 * @returns {{ exitCode: 0 | 1 | 2, red: string[], applied: Array<object>, problems: string[] }}
 *   exitCode 0 green, 1 red, 2 not graded; red, the red rows no deferral
 *   covers; applied, exclusions plus each deferral that covered red rows, with those rows;
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

  const byProbe = new Map(deferred.filter((entry) => entry.excluded !== true).map((entry) => [entry.probe, entry]));
  const red = [];
  const covered = new Map();
  for (const row of rows) {
    if (row.exitCode === 0 || (row.name === 'probes' && row.exitCode === 2)) continue;
    const entry = row.name.startsWith('tests/behavioral/') ? byProbe.get(probeOf(row.name)) : undefined;
    const beyond = entry ? beyondDeferral(row, entry) : null;
    if (entry && beyond === null) {
      if (!covered.has(entry.probe)) covered.set(entry.probe, []);
      covered.get(entry.probe).push({ task: row.task, exitCode: row.exitCode, seconds: row.seconds, output: row.output });
    } else {
      red.push(`${row.name} (${row.task}, exit ${row.exitCode})${beyond ? `: deferred for ✗ ${entry.assertion} only, and ${beyond}` : ''}`);
    }
  }
  if (red.length > 0) problems.push(`red: ${red.join('; ')}`);
  for (const entry of deferred) {
    const own = rows.filter((row) => row.name.startsWith('tests/behavioral/') && probeOf(row.name) === entry.probe);
    if (entry.excluded === true) {
      if (own.length > 0) problems.push(`${entry.probe} ran despite its release exclusion (tests/behavioral/_deferred.mjs)`);
      continue;
    }
    if (own.some((row) => row.exitCode === 0)) problems.push(`${entry.probe} passes; remove its deferral (tests/behavioral/_deferred.mjs)`);
    else if (own.length === 0 && !notGraded) problems.push(`${entry.probe} did not run; its deferral names nothing the matrix ran (tests/behavioral/_deferred.mjs)`);
  }
  const applied = deferred.filter((entry) => entry.excluded === true
    ? !rows.some((row) => probeOf(row.name) === entry.probe)
    : covered.has(entry.probe) && !rows.some((row) => probeOf(row.name) === entry.probe && row.exitCode === 0)
    && !red.some((line) => probeOf(line.split(' ')[0]) === entry.probe))
    .map((entry) => entry.excluded === true ? { ...entry } : { ...entry, rows: covered.get(entry.probe) });
  const exitCode = notGraded ? 2 : problems.length > 0 ? 1 : 0;
  return { exitCode, red, applied, problems };
}
