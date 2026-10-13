#!/usr/bin/env bun
// Regenerate Lean fixtures on armada, never on the workstation. The container
// returns the model's own git patch and blob ids; the caller checks and applies
// only that generated fixture patch. --model-only is a targeted proof-build.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapOnArmada } from '../scripts/ci/lib/armada.mjs';

const args = process.argv.slice(2);
const container = args.includes('--container');
const modelOnly = args.includes('--model-only');
const outAt = args.indexOf('--out');
const positional = args.filter((arg, i) => !arg.startsWith('--') && (outAt < 0 || i !== outAt + 1));
const git = (argv, options = {}) => {
  const result = spawnSync('git', argv, { encoding: 'utf8', maxBuffer: 1 << 28, ...options });
  if (result.status !== 0) throw new Error(`git ${argv[0]}: ${result.stderr || result.error?.message}`);
  return result.stdout.trimEnd();
};

if (container) {
  const out = outAt < 0 ? null : args[outAt + 1];
  if (!out) throw new Error('--container requires --out');
  const head = git(['rev-parse', 'HEAD']);
  const rows = [];
  const run = (name, command, argv) => {
    const start = performance.now();
    const result = spawnSync(command, argv, { cwd: 'lean', encoding: 'utf8', maxBuffer: 1 << 28 });
    const row = { name, exitCode: result.status ?? 2, seconds: (performance.now() - start) / 1000,
      output: `${result.stdout || ''}${result.stderr || ''}${result.error?.message || ''}` };
    rows.push(row);
    return row.exitCode === 0;
  };
  let ok = run('model-build', 'lake', ['build', 'Nimbus.Vfs.CompositeOps']);
  if (ok && !modelOnly) {
    ok = run('fixture-build', 'lake', ['build', 'fixtures']);
    if (ok) ok = run('fixture-generation', '.lake/build/bin/fixtures', ['fixtures']);
  }
  const diff = git(['diff', '--binary', '--', 'lean/fixtures']);
  const patch = diff ? `${diff}\n` : '';
  const paths = git(['diff', '--name-only', '--', 'lean/fixtures']).split('\n').filter(Boolean);
  const blobs = Object.fromEntries(paths.map((path) => [path, git(['hash-object', path])]));
  writeFileSync(out, JSON.stringify({ head, rows, patch, blobs }));
  for (const row of rows) console.log(`${row.name}: exit ${row.exitCode}, ${row.seconds.toFixed(1)}s\n${row.output}`);
  process.exit(ok ? 0 : 1);
}

if (positional.length > 1 || outAt >= 0 || args.some((arg) => arg.startsWith('--') && arg !== '--model-only')) {
  throw new Error('usage: bun lean/regenerate-fixtures.mjs [<commit>] [--model-only]');
}
const repo = git(['rev-parse', '--show-toplevel']);
const sha = git(['rev-parse', '--verify', `${positional[0] || 'HEAD'}^{commit}`]);
const mapped = await mapOnArmada({ repo, sha, files: ['lean/regenerate-fixtures.mjs'], items: [1],
  label: `lean ${modelOnly ? 'model' : 'fixtures'} ${sha.slice(0, 12)}`, pool: 1,
  command: ['bun', 'lean/regenerate-fixtures.mjs', '--container', '--out', '{out}', ...(modelOnly ? ['--model-only'] : [])] });
const verdict = mapped.outputs[0] === null ? null : JSON.parse(mapped.outputs[0]);
const stem = join(tmpdir(), `lean-${sha.slice(0, 12)}-${mapped.jobId}`);
mkdirSync(tmpdir(), { recursive: true });
writeFileSync(`${stem}.json`, `${JSON.stringify({ sha, ...mapped, verdict }, null, 2)}\n`);
if (verdict === null || verdict.head !== mapped.commit) {
  throw new Error(`Lean not graded; receipt ${stem}.json; ${mapped.outcomes[0]?.tail || 'no outcome'}`);
}
for (const row of verdict.rows) console.log(`${row.name}: exit ${row.exitCode}, ${row.seconds.toFixed(1)}s\n${row.output}`);
if (verdict.patch) {
  const paths = Object.keys(verdict.blobs);
  if (paths.some((path) => !/^lean\/fixtures\/[a-z0-9-]+\.json$/.test(path))) throw new Error('fixture patch escaped lean/fixtures');
  writeFileSync(`${stem}.patch`, verdict.patch);
  if (git(['rev-parse', 'HEAD']) !== sha || git(['status', '--porcelain', '--', ...paths])) {
    console.log(`Generated patch saved, not applied to a changed worktree: ${stem}.patch`);
  } else {
    git(['apply', '--check', `${stem}.patch`]);
    git(['apply', '--whitespace=nowarn', `${stem}.patch`]);
    for (const path of paths) {
      if (git(['hash-object', path]) !== verdict.blobs[path]) throw new Error(`generated blob mismatch: ${path}`);
    }
    console.log(`Applied model-generated fixture patch: ${paths.join(', ')}`);
  }
}
console.log(`Lean receipt: ${stem}.json (job ${mapped.jobId})`);
process.exit(mapped.outcomes[0]?.exitCode ?? 2);
