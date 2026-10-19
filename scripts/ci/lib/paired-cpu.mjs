// The verdict of a paired in-process CPU bench (tests/bench/lib/paired-cpu.mjs)
// over independent runs, each a process of its own: what one process's state
// does to a whole run is noise across them, and the interval is taken over runs.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { parseArgs } from 'node:util';
import { mapOnArmada, overlayCommit, SELF_ROOT } from './armada.mjs';
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

/**
 * How a paired CPU bench runs from its command line (`argv`: `<baseline>
 * [<revision>] [--short] [--engine node|bun]`): the engine it runs on, its
 * own (`engine`, the one it is graded on) unless `--engine` names another of
 * `engines` (those its bench can run on), and each run's command. An error
 * names what is wrong, before anything is sent to armada.
 */
export function pairedCpuPlan(argv, { name, engine: graded, engines = [graded], bench, baselineDir }) {
  const { values, positionals } = parseArgs({ args: argv, options: { short: { type: 'boolean', default: false }, engine: { type: 'string' } }, allowPositionals: true });
  const [baseline, revision = 'HEAD'] = positionals;
  if (!baseline || positionals.length > 2) return { error: `usage: ${name}.mjs <baseline> [<revision>] [--short] [--engine ${engines.join('|')}]` };
  const engine = values.engine ?? graded;
  if (!engines.includes(engine)) return { error: `${name}: its bench runs on ${engines.join(' or ')}, not ${engine}` };
  return {
    baseline, revision, engine, short: values.short,
    // Graded only on its own engine, and not when short.
    graded: engine === graded && !values.short,
    command: [engine, bench, '--baseline', baselineDir, '--out', '{out}', ...(values.short ? ['--short'] : [])],
  };
}

/**
 * Whether the bench passes, from its sets of runs (`sets`, each armada's
 * outcomes and the results each run wrote) and its verdicts: every run of
 * every set finished and measured every kind, and no kind is slower.
 */
export function pairedCpuPasses(sets, verdicts, runsPerSet) {
  const measuredAll = sets.every(({ results }) => results.length === runsPerSet)
    && sets.every(({ verdicts: graded }) => graded.every((verdict) => verdict.runs === runsPerSet));
  const finished = sets.every(({ outcomes }) => outcomes.every((outcome) => outcome.kind === 'exited' && outcome.exitCode === 0));
  return measuredAll && finished && verdicts.every((verdict) => verdict.failures.length === 0);
}

/** A module's relative imports (static, re-exports, literal dynamic ones). */
const IMPORTS = /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;

/**
 * A paired bench's harness: `bench` (a path from `root`) and every file of
 * this repository's tests/ and scripts/ it imports, transitively. Throws if
 * one imports workspace package code (packages/): that code is each arm's
 * own, taken from its tree (tests/bench/lib/isolated-core.mjs), never the
 * harness's.
 */
export function benchHarness(bench, root = SELF_ROOT) {
  const files = new Set();
  const pending = [bench];
  while (pending.length > 0) {
    const path = pending.pop();
    if (files.has(path)) continue;
    files.add(path);
    for (const match of readFileSync(join(root, path), 'utf8').matchAll(IMPORTS)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier.startsWith('.')) continue;
      const target = normalize(join(dirname(path), specifier));
      if (target.startsWith('packages/')) {
        throw new Error(`${path} imports ${specifier}: a paired bench's harness takes no workspace package code of its own; take it from the arm (loadIsolatedCore modules or helpers)`);
      }
      if (/^(tests|scripts)\//.test(target) && existsSync(join(root, target))) pending.push(target);
    }
  }
  return [...files].sort();
}

/**
 * The commit a paired run sends: `revision`'s tree, with this checkout's
 * bench harness (benchHarness) laid over it, so a run of an older revision
 * measures it with the bench as it is now, and `baseline`'s whole tree under
 * `baselineDir`.
 */
export function pairedRunCommit({ repo, revision, baseline, baselineDir, bench, from = SELF_ROOT }) {
  return overlayCommit(repo, revision, [...benchHarness(bench, from), { path: baselineDir, tree: baseline }], from);
}

const git = (...args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};

/**
 * A paired CPU bench of `revision` (default HEAD) against `baseline`, from
 * the command line (`<baseline> [<revision>]`), on armada: RUNS processes,
 * each given the baseline's whole tree under `baselineDir` (each arm runs
 * its side's whole code: tests/bench/lib/isolated-core.mjs) and this
 * checkout's bench (pairedRunCommit), as
 * `<engine> <bench> --baseline <baselineDir> --out <file>`. `engine` is the
 * one the code runs on in production: `node` (V8, as workerd runs the
 * guest's code) or `bun`; `--engine` runs another, for context, and the
 * receipt names it. Writes
 * the receipt under NIMBUS_STATE/`receipts`, prints the verdicts, and exits
 * 0 only when every run finished and no kind is slower.
 * `--short` runs two small workload smoke checks without grading performance.
 *
 * @param {{ name: string, receipts: string, baselineDir: string, engine: 'node' | 'bun', engines?: ('node' | 'bun')[], bench: string }} bench
 */
export async function remotePairedCpu(bench) {
  const { name, receipts, baselineDir, engine: graded } = bench;
  const plan = pairedCpuPlan(process.argv.slice(2), bench);
  if ('error' in plan) throw new Error(plan.error);
  const { engine, short } = plan;
  const RUNS = short ? 2 : 8;
  const repo = git('rev-parse', '--show-toplevel').trim();
  const sha = git('rev-parse', `${plan.revision}^{commit}`).trim();
  const base = git('rev-parse', `${plan.baseline}^{commit}`).trim();
  const measured = pairedRunCommit({ repo, revision: sha, baseline: base, baselineDir, bench: bench.bench });
  const runSet = (label) => mapOnArmada({
    repo, sha: measured, files: [], items: Array.from({ length: RUNS }, (_, i) => i + 1), pool: RUNS, timeout: 1200,
    label: `${name} ${sha.slice(0, 12)} ${engine}${label}`,
    command: plan.command,
  });
  const resultsOf = (set) => set.outputs.filter((output) => output !== null).map((output) => JSON.parse(output));
  const run = await runSet('');
  const runs = resultsOf(run);
  const first = short ? [] : pairedCpuVerdicts(runs);
  // A slower kind is measured again, on a second set of runs, before it is called slower.
  const confirmation = first.some((verdict) => verdict.failures.length > 0) ? await runSet(' confirmation') : null;
  const again = confirmation ? pairedCpuVerdicts(resultsOf(confirmation)) : [];
  const verdicts = confirmation ? confirmedVerdicts(first, again) : first;
  const directory = join(NIMBUS_STATE, receipts);
  mkdirSync(directory, { recursive: true });
  const receipt = join(directory, `${short ? 'short-' : ''}${sha.slice(0, 12)}-${run.jobId}.json`);
  writeFileSync(receipt, `${JSON.stringify({ baseline: base, head: sha, engine, gradedEngine: graded, short, performanceGraded: plan.graded, verdicts, ...run, ...(confirmation ? { confirmation } : {}) }, null, 2)}\n`);
  console.log(`receipt: ${receipt}`);
  const sets = [{ ...run, results: runs, verdicts: first }, ...(confirmation ? [{ ...confirmation, results: resultsOf(confirmation), verdicts: again }] : [])];
  for (const set of sets) for (const outcome of set.outcomes) if (outcome.kind !== 'exited' || outcome.exitCode !== 0) console.log(outcome.tail);
  for (const verdict of verdicts) console.log(JSON.stringify(verdict));
  // A kind that some run of either set did not measure fails the bench: fewer runs pass nothing.
  for (const verdict of [...first, ...again]) if (verdict.runs !== RUNS) console.log(`incomplete: ${verdict.kind} was measured in ${verdict.runs} of ${RUNS} runs of a set`);
  if (short) console.log(`short smoke: ${runs.length}/${RUNS} runs completed; performance is not graded`);
  if (engine !== graded) console.log(`${engine}: context only; ${name} is graded on ${graded}`);
  process.exit(pairedCpuPasses(sets, verdicts, RUNS) ? 0 : 1);
}
