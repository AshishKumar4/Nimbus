#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapOnArmada } from './lib/armada.mjs';
import { NIMBUS_STATE } from './lib/state-dir.mjs';

const git = (...args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};
const [baseline, revision = 'HEAD'] = process.argv.slice(2);
if (!baseline) throw new Error('usage: remote-vfs-lookup-cpu.mjs <baseline> [<revision>]');
const repo = git('rev-parse', '--show-toplevel').trim();
const sha = git('rev-parse', `${revision}^{commit}`).trim();
const base = git('rev-parse', `${baseline}^{commit}`).trim();
const baselineDir = '.ci-vfs-baseline';
const files = ['sqlite-vfs.ts', 'path.ts', 'composite.ts'].map((name) => ({
  path: `${baselineDir}/${name}`, bytes: git('show', `${base}:packages/core/src/vfs/${name}`),
}));
const run = await mapOnArmada({
  repo, sha, files, items: [1], pool: 1, timeout: 1200,
  label: `vfs-lookup-cpu ${sha.slice(0, 12)}`,
  command: ['bun', 'tests/bench/vfs-lookup-cpu.mjs', '--baseline', baselineDir, '--out', '{out}'],
});
const directory = join(NIMBUS_STATE, 'remote-vfs-cpu');
mkdirSync(directory, { recursive: true });
const receipt = join(directory, `${sha.slice(0, 12)}-${run.jobId}.json`);
writeFileSync(receipt, `${JSON.stringify({ baseline: base, head: sha, ...run }, null, 2)}\n`);
console.log(`receipt: ${receipt}`);
for (const outcome of run.outcomes) console.log(outcome.tail);
process.exit(run.outcomes.every((outcome) => outcome.kind === 'exited' && outcome.exitCode === 0) ? 0 : 1);
