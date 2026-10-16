// The verdict of a paired in-process CPU bench (tests/bench/lib/paired-cpu.mjs)
// over independent runs, each a process of its own: what one process's state
// does to a whole run is noise across them, and the interval is taken over runs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapOnArmada, overlayCommit } from './armada.mjs';
import { NIMBUS_STATE } from './state-dir.mjs';

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor(fraction * (values.length - 1))];

/**
 * Each kind over `runs` (each run's results, as the bench wrote them): the
 * median of the runs' branch delta less their null delta (a second copy of
 * the baseline, paired with the same A), its bootstrap interval, and the
 * spread of the runs' null deltas, the A/A. The bar is no detectable loss: a
 * kind fails only when its interval lies wholly above 0.
 */
export function pairedCpuVerdicts(runs) {
  return (runs[0] ?? []).map(({ kind }) => {
    const of = runs.map((results) => results.find((result) => result.kind === kind));
    const deltas = of.map((result) => result.medianDelta - result.medianNullDelta);
    const aa = of.map((result) => result.medianNullDelta);
    const boot = [];
    let state = 0x51_53;
    for (let sample = 0; sample < 3000; sample++) {
      const draw = [];
      for (let i = 0; i < deltas.length; i++) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        draw.push(deltas[(state >>> 0) % deltas.length]);
      }
      boot.push(median(draw));
    }
    const ci95 = [quantile(boot, 0.025), quantile(boot, 0.975)];
    const aaSpread = [Math.min(...aa), Math.max(...aa)];
    const failures = ci95[0] > 0 ? [`slower: the paired CPU delta's interval [${ci95[0]}, ${ci95[1]}] ms lies above 0`] : [];
    return { kind, runs: deltas.length, medianA: median(of.map((result) => result.medianA)), medianB: median(of.map((result) => result.medianB)), medianDelta: median(deltas), ci95, aaSpread, failures };
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
 * each given the baseline's `files` (paths under `source`; every file there
 * when omitted) under `baselineDir`, as
 * `command --baseline <baselineDir> --out <file>`. Writes
 * the receipt under NIMBUS_STATE/`receipts`, prints the verdicts, and exits
 * 0 only when every run finished and no kind is slower.
 */
export async function remotePairedCpu({ name, receipts, source, baselineDir, files, command }) {
  const RUNS = 8;
  const [baseline, revision = 'HEAD'] = process.argv.slice(2);
  if (!baseline) throw new Error(`usage: ${name}.mjs <baseline> [<revision>]`);
  const repo = git('rev-parse', '--show-toplevel').trim();
  const sha = git('rev-parse', `${revision}^{commit}`).trim();
  const base = git('rev-parse', `${baseline}^{commit}`).trim();
  const names = files ?? git('ls-tree', '-r', '--name-only', base, `${source}/`).split('\n').filter(Boolean).map((path) => path.slice(source.length + 1));
  const measured = overlayCommit(repo, sha, names.map((path) => ({ path: `${baselineDir}/${path}`, bytes: git('show', `${base}:${source}/${path}`) })));
  const run = await mapOnArmada({
    repo, sha: measured, files: [], items: Array.from({ length: RUNS }, (_, i) => i + 1), pool: RUNS, timeout: 1200,
    label: `${name} ${sha.slice(0, 12)}`,
    command: [...command, '--baseline', baselineDir, '--out', '{out}'],
  });
  const runs = run.outputs.filter((output) => output !== null).map((output) => JSON.parse(output));
  const verdicts = pairedCpuVerdicts(runs);
  const directory = join(NIMBUS_STATE, receipts);
  mkdirSync(directory, { recursive: true });
  const receipt = join(directory, `${sha.slice(0, 12)}-${run.jobId}.json`);
  writeFileSync(receipt, `${JSON.stringify({ baseline: base, head: sha, verdicts, ...run }, null, 2)}\n`);
  console.log(`receipt: ${receipt}`);
  for (const outcome of run.outcomes) if (outcome.kind !== 'exited' || outcome.exitCode !== 0) console.log(outcome.tail);
  for (const verdict of verdicts) console.log(JSON.stringify(verdict));
  const complete = runs.length === RUNS && run.outcomes.every((outcome) => outcome.kind === 'exited' && outcome.exitCode === 0);
  process.exit(complete && verdicts.every((verdict) => verdict.failures.length === 0) ? 0 : 1);
}
