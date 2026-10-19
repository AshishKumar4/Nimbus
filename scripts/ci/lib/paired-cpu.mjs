// The verdict of a paired in-process CPU bench (tests/bench/lib/paired-cpu.mjs)
// over independent runs, each a process of its own: what one process's state
// does to a whole run is noise across them, and the interval is taken over runs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { mapOnArmada, overlayCommit } from './armada.mjs';
import { NIMBUS_STATE } from './state-dir.mjs';
import { median, medianInterval } from '../../lib/statistics.mjs';


/**
 * Each kind over `runs` (each run's results, as the bench wrote them): the
 * median of each run's paired branch-minus-null differences (a second copy
 * of the baseline), its bootstrap interval, and the
 * spread of the runs' null deltas, the A/A. The bar is no detectable loss: a
 * kind fails when its interval lies wholly above 0 (confirmedVerdicts then
 * asks a second set of runs).
 */
export function pairedCpuVerdicts(runs) {
  return [...new Set(runs.flatMap((results) => results.map(({ kind }) => kind)))].map((kind) => {
    const of = runs.flatMap((results) => results.filter((result) => result.kind === kind));
    // Cancel the common A inside each pair, not after two independent medians:
    // median(real - A) - median(null - A) need not equal median(real - null).
    const deltas = of.map((result) => median(result.samples.map((sample) => sample.real - sample.null)));
    const aa = of.map((result) => result.medianNullDelta);
    const ci95 = medianInterval(deltas);
    const aaSpread = [Math.min(...aa), Math.max(...aa)];
    const failures = ci95[0] > 0 ? [`slower: the paired CPU delta's interval [${ci95[0]}, ${ci95[1]}] ms lies above 0`] : [];
    return { kind, runs: deltas.length, medianA: median(of.map((result) => result.medianA)), medianB: median(of.map((result) => result.medianB)), medianDelta: median(deltas), ci95, aaSpread, failures };
  });
}

/**
 * `verdicts` with each slower kind confirmed by `again` (the verdicts of a
 * second set of runs): a kind is slower only when both sets find it slower.
 * Its interval is drawn from one set of processes, and at 95% a bench with
 * a dozen kinds finds about one slower in two runs that are not. A kind the
 * second set did not measure stays slower.
 */
export function confirmedVerdicts(verdicts, again) {
  return verdicts.map((verdict) => {
    if (verdict.failures.length === 0) return verdict;
    const second = again.find((other) => other.kind === verdict.kind);
    if (!second) return { ...verdict, confirmation: null, failures: [...verdict.failures, 'unconfirmed: the second set of runs measured no such kind'] };
    const confirmation = { medianDelta: second.medianDelta, ci95: second.ci95, failures: second.failures };
    return { ...verdict, confirmation, failures: second.failures.length > 0 ? [...verdict.failures, 'confirmed: a second set of runs finds it slower too'] : [] };
  });
}

const git = (...args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};

/**
 * A paired CPU bench of `revision` (default HEAD) against `baseline`, from
 * the command line (`<baseline> [<revision>]`), on armada: RUNS processes,
 * each given the baseline's `files` or `directories` (paths under `source`;
 * every file there when both are omitted) under `baselineDir`, as
 * `command --baseline <baselineDir> --out <file>`. Writes
 * the receipt under NIMBUS_STATE/`receipts`, prints the verdicts, and exits
 * 0 only when every run finished and no kind is slower.
 * `--short` runs two small workload smoke checks without grading performance.
 *
 * @param {{ name: string, receipts: string, source: string, baselineDir: string, files?: string[], directories?: string[], command: string[] }} bench
 */
export async function remotePairedCpu({ name, receipts, source, baselineDir, files, directories, command }) {
  const { values, positionals } = parseArgs({ options: { short: { type: 'boolean', default: false } }, allowPositionals: true });
  const RUNS = values.short ? 2 : 8;
  const [baseline, revision = 'HEAD'] = positionals;
  if (!baseline || positionals.length > 2) throw new Error(`usage: ${name}.mjs <baseline> [<revision>] [--short]`);
  const repo = git('rev-parse', '--show-toplevel').trim();
  const sha = git('rev-parse', `${revision}^{commit}`).trim();
  const base = git('rev-parse', `${baseline}^{commit}`).trim();
  const names = [...new Set([
    ...(files ?? []),
    ...(directories !== undefined || files === undefined
      ? git('ls-tree', '-r', '--name-only', base, '--', ...(directories ?? ['']).map((path) => path ? `${source}/${path}/` : `${source}/`))
        .split('\n').filter(Boolean).map((path) => path.slice(source.length + 1)) : []),
  ])];
  const measured = overlayCommit(repo, sha, names.map((path) => ({ path: `${baselineDir}/${path}`, bytes: git('show', `${base}:${source}/${path}`) })));
  const runSet = (label) => mapOnArmada({
    repo, sha: measured, files: [], items: Array.from({ length: RUNS }, (_, i) => i + 1), pool: RUNS, timeout: 1200,
    label: `${name} ${sha.slice(0, 12)}${label}`,
    command: [...command, '--baseline', baselineDir, '--out', '{out}', ...(values.short ? ['--short'] : [])],
  });
  const resultsOf = (set) => set.outputs.filter((output) => output !== null).map((output) => JSON.parse(output));
  const run = await runSet('');
  const runs = resultsOf(run);
  const first = values.short ? [] : pairedCpuVerdicts(runs);
  // A slower kind is measured again, on a second set of runs, before it is called slower.
  const confirmation = first.some((verdict) => verdict.failures.length > 0) ? await runSet(' confirmation') : null;
  const again = confirmation ? pairedCpuVerdicts(resultsOf(confirmation)) : [];
  const verdicts = confirmation ? confirmedVerdicts(first, again) : first;
  const directory = join(NIMBUS_STATE, receipts);
  mkdirSync(directory, { recursive: true });
  const receipt = join(directory, `${values.short ? 'short-' : ''}${sha.slice(0, 12)}-${run.jobId}.json`);
  writeFileSync(receipt, `${JSON.stringify({ baseline: base, head: sha, short: values.short, performanceGraded: !values.short, verdicts, ...run, ...(confirmation ? { confirmation } : {}) }, null, 2)}\n`);
  console.log(`receipt: ${receipt}`);
  const sets = [run, ...(confirmation ? [confirmation] : [])];
  for (const set of sets) for (const outcome of set.outcomes) if (outcome.kind !== 'exited' || outcome.exitCode !== 0) console.log(outcome.tail);
  for (const verdict of verdicts) console.log(JSON.stringify(verdict));
  // A kind that some run of either set did not measure fails the bench: fewer runs pass nothing.
  const partial = [...first, ...again].filter((verdict) => verdict.runs !== RUNS);
  for (const verdict of partial) console.log(`incomplete: ${verdict.kind} was measured in ${verdict.runs} of ${RUNS} runs of a set`);
  const complete = partial.length === 0 && sets.every((set) => resultsOf(set).length === RUNS && set.outcomes.every((outcome) => outcome.kind === 'exited' && outcome.exitCode === 0));
  if (values.short) console.log(`short smoke: ${runs.length}/${RUNS} runs completed; performance is not graded`);
  process.exit(complete && verdicts.every((verdict) => verdict.failures.length === 0) ? 0 : 1);
}
