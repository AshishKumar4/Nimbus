#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapOnArmada, overlayCommit } from './lib/armada.mjs';
import { NIMBUS_STATE } from './lib/state-dir.mjs';

const git = (...args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};
const [baseline, revision = 'HEAD'] = process.argv.slice(2);
if (!baseline) throw new Error('usage: remote-vfs-lookup-cpu.mjs <baseline> [<revision>]');
// Independent runs, each a process of its own: what one process's state does
// to a whole run is noise across them, and the interval is taken over runs.
const RUNS = 8;
const repo = git('rev-parse', '--show-toplevel').trim();
const sha = git('rev-parse', `${revision}^{commit}`).trim();
const base = git('rev-parse', `${baseline}^{commit}`).trim();
const baselineDir = '.ci-vfs-baseline';
const files = ['vfs/sqlite-vfs.ts', 'vfs/path.ts', 'vfs/composite.ts', 'vfs/sqlite-files.ts', 'runtime/process-files.ts', 'runtime/sqlite-runtime-fs-bridge.ts'].map((name) => ({
  path: `${baselineDir}/${name}`, bytes: git('show', `${base}:packages/core/src/${name}`),
}));
const measured = overlayCommit(repo, sha, files);
const run = await mapOnArmada({
  repo, sha: measured, files: [], items: Array.from({ length: RUNS }, (_, i) => i + 1), pool: RUNS, timeout: 1200,
  label: `vfs-lookup-cpu ${sha.slice(0, 12)}`,
  command: ['bun', 'tests/bench/vfs-lookup-cpu.mjs', '--baseline', baselineDir, '--out', '{out}'],
});
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor(fraction * (values.length - 1))];
// Each kind over the runs: the median of the runs' paired deltas, its
// bootstrap interval, and the spread of the runs' A/A medians.
const runs = run.outputs.filter((output) => output !== null).map((output) => JSON.parse(output));
const verdicts = (runs[0] ?? []).map(({ kind }) => {
  const of = runs.map((results) => results.find((result) => result.kind === kind));
  const deltas = of.map((result) => result.medianDelta);
  const aa = of.map((result) => result.medianAA);
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
  const failures = [];
  if (median(deltas) > 0) failures.push(`median paired CPU delta ${median(deltas)} ms is positive`);
  if (ci95[1] >= 0 && (ci95[0] < aaSpread[0] || ci95[1] > aaSpread[1])) failures.push('confidence interval is outside A/A spread');
  return { kind, runs: deltas.length, medianA: median(of.map((result) => result.medianA)), medianB: median(of.map((result) => result.medianB)), medianDelta: median(deltas), ci95, aaSpread, failures };
});
const directory = join(NIMBUS_STATE, 'remote-vfs-cpu');
mkdirSync(directory, { recursive: true });
const receipt = join(directory, `${sha.slice(0, 12)}-${run.jobId}.json`);
writeFileSync(receipt, `${JSON.stringify({ baseline: base, head: sha, verdicts, ...run }, null, 2)}\n`);
console.log(`receipt: ${receipt}`);
for (const outcome of run.outcomes) if (outcome.kind !== 'exited' || outcome.exitCode !== 0) console.log(outcome.tail);
for (const verdict of verdicts) console.log(JSON.stringify(verdict));
const complete = runs.length === RUNS && run.outcomes.every((outcome) => outcome.kind === 'exited' && outcome.exitCode === 0);
process.exit(complete && verdicts.every((verdict) => verdict.failures.length === 0) ? 0 : 1);
