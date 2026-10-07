#!/usr/bin/env bun
// The behavioral suite against a deployed target, from containers on armada
// instead of this machine: each part runs scripts/ci/probes.mjs in a
// container of its own, with Chromium for the browser probes.
//
//   bun scripts/ci/remote-probes.mjs --target staging|throwaway:<name> [<commit>]
//       [--only a,b] [--skip c,d] [--parts N] [--jobs J] [--repeat a,b --times T]
//
// Run it in the lane's worktree. The probes are <commit>'s (default HEAD),
// so commit first. The token is minted here, by the target's own `token
// --json` (tests/behavioral/_staging-target.mjs or _throwaway-target.mjs),
// with a two-hour lifetime: armada keeps a job's environment while the job
// lives, so only a credential for this target and run goes there, and no
// output carries it (probes.mjs scrubs).
//
// --parts N splits the selection N ways, each run --jobs J at a time
// (default 4 × 4: the 16 probes at once the suite has always run, so the
// target sees the same load). --only/--skip select as run-all does; against
// either target (both are apps/probe) the skips default to
// PROBE_TARGET_SKIPS. --repeat runs each named probe --times more times
// (default 5), each alone and beside the suite, as the release matrix does
// with write-heavy probes whose failure is intermittent.
//
// It prints one line per task and every red row with its output tail, and
// keeps the whole verdict under ~/.local/state/nimbus/remote-probes/.
// Exit: 0, every row green; 1, a red row; 2, a task not graded.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROBE_TARGET_SKIPS } from '../../tests/behavioral/_probe-target-skips.mjs';
import { mapOnArmada } from './lib/armada.mjs';

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

const argv = process.argv.slice(2);
const VALUED = ['--target', '--only', '--skip', '--parts', '--jobs', '--repeat', '--times'];
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUED.includes(argv[i]) && argv[i + 1] !== undefined) flags[argv[i].slice(2)] = argv[++i];
  else if (!argv[i].startsWith('--')) positional.push(argv[i]);
  else usage(`unexpected ${argv[i]}`);
}
const target = /^(staging|throwaway:(.+))$/.exec(flags.target ?? '');
if (!target || positional.length > 1) usage('--target staging or --target throwaway:<name> is required');
const count = (name, fallback) => {
  const value = flags[name] === undefined ? fallback : Number(flags[name]);
  if (!Number.isInteger(value) || value < 1) usage(`--${name} must be a positive integer`);
  return value;
};
const parts = count('parts', 4);
const jobs = count('jobs', 4);
const times = count('times', 5);
function usage(why) {
  console.error(`${why}\nusage: bun scripts/ci/remote-probes.mjs --target staging|throwaway:<name> [<commit>] [--only a,b] [--skip c,d] [--parts N] [--jobs J] [--repeat a,b --times T]`);
  process.exit(2);
}

const git = (cwd, args) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || done.error?.message || '').trim()}`);
  return done.stdout.trim();
};
const repo = git(process.cwd(), ['rev-parse', '--show-toplevel']);
const sha = git(repo, ['rev-parse', '--verify', `${positional[0] ?? 'HEAD'}^{commit}`]);

const minter = target[2] === undefined
  ? ['tests/behavioral/_staging-target.mjs', 'token']
  : ['tests/behavioral/_throwaway-target.mjs', 'token', '--name', target[2]];
const minted = spawnSync('bun', [...minter, '--json', '--ttl-ms', String(TOKEN_TTL_MS)], { cwd: repo, encoding: 'utf8' });
if (minted.status !== 0) {
  console.error(`remote-probes: NOT GRADED — could not mint a token for ${flags.target}:\n${minted.stderr}`);
  process.exit(2);
}
const { base, token } = JSON.parse(minted.stdout);
const scrub = (text) => text.replaceAll(token, '[NIMBUS_PROBE_TOKEN]');

const skip = flags.skip ?? PROBE_TARGET_SKIPS.join(',');
const items = [
  ...Array.from({ length: parts }, (_, i) => ({ task: `part ${i + 1}/${parts}`, part: `${i + 1}/${parts}`, only: flags.only ?? '', jobs })),
  ...(flags.repeat ?? '').split(',').filter(Boolean).flatMap((probe) => Array.from({ length: times }, (_, i) => ({
    task: `${probe} #${i + 1}`, part: '1/1', only: probe, jobs: 1,
  }))),
];
console.error(`remote-probes: ${items.length} tasks against ${base}, probes of ${sha.slice(0, 12)}`);

let mapped;
try {
  mapped = await mapOnArmada({
    repo, sha, files: ['scripts/ci/probes.mjs', 'tests/behavioral/run-all.mjs'], setup: 'scripts/armada/chromium.sh',
    items, env: { NIMBUS_PROBE_TOKEN: token }, label: `remote-probes ${sha.slice(0, 12)} ${flags.target}`,
    command: ['bun', 'scripts/ci/probes.mjs', '--out', '{out}', '--base', base, '--only', '{only}', '--skip', skip, '--part', '{part}', '--jobs', '{jobs}'],
  });
} catch (error) {
  console.error(`remote-probes: NOT GRADED — ${scrub(error.message)}`);
  process.exit(2);
}

let status = 0;
const tasks = mapped.outcomes.map((outcome, i) => {
  const item = items[outcome.index];
  let verdict = null;
  try { verdict = JSON.parse(mapped.outputs[i] ?? 'null'); } catch { /* reported below */ }
  if (outcome.kind !== 'exited' || verdict === null) {
    status = 2;
    console.log(`NOT GRADED ${item.task}: ${outcome.kind === 'exited' ? `exit ${outcome.exitCode}, no verdict` : 'armada could not run it'}\n${scrub(outcome.tail ?? '')}`);
    return { ...item, outcome, rows: null };
  }
  const red = verdict.rows.filter((row) => row.exitCode !== 0);
  if (red.some((row) => row.exitCode === 2)) status = 2;
  else if (red.length > 0 && status === 0) status = 1;
  console.log(`${red.length === 0 ? 'ok  ' : 'FAIL'} ${item.task}: ${verdict.rows.length - red.length} of ${verdict.rows.length} rows green in ${Math.round(outcome.seconds)} s`);
  for (const row of red) console.log(`  FAIL ${row.name} (exit ${row.exitCode}, ${Math.round(row.seconds)} s)\n${row.output.trimEnd().split('\n').slice(-25).map((line) => `    ${line}`).join('\n')}`);
  return { ...item, outcome, rows: verdict.rows };
});

const state = join(homedir(), '.local', 'state', 'nimbus', 'remote-probes');
mkdirSync(state, { recursive: true });
const report = join(state, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${sha.slice(0, 12)}.json`);
writeFileSync(report, `${JSON.stringify({ commit: sha, target: flags.target, base, job: mapped.jobId, tasks }, null, 2)}\n`);
console.log(`remote-probes: ${status === 0 ? 'every row green' : status === 1 ? 'red rows above' : 'not every task was graded'}; verdict ${report} (job ${mapped.jobId})`);
process.exit(status);
