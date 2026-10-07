#!/usr/bin/env bun
// The behavioral suite against a deployed target, from containers on armada
// instead of this machine: each part runs scripts/ci/probes.mjs in a
// container of its own, with Chromium for the browser probes.
//
//   bun scripts/ci/remote-probes.mjs --target staging|throwaway:<name> [<commit>]
//       [--only a,b] [--skip c,d] [--parts N] [--jobs J] [--repeat a,b --times T]
//   bun scripts/ci/remote-probes.mjs --deploy <name> [<commit>] [--only a,b] [--skip c,d] [--parts N] [--jobs J]
//   bun scripts/ci/remote-probes.mjs --target hosted:<https origin> [<commit>] --only a,b
//
// --target hosted:<origin> runs the named hosted-demo checks against a
// deployed demo (staging's, or production's at promotion) as a visitor
// reaches it: no token, no probe-target skips.
//
// Run it in the lane's worktree. The probes are <commit>'s (default HEAD),
// so commit first. The token is minted here, by the target's own `token
// --json` (tests/behavioral/_staging-target.mjs or _throwaway-target.mjs),
// and lives only as long as the job may: armada keeps a job's environment,
// so only a credential for this target and run goes there, expiring with
// it, and no output carries it (probes.mjs scrubs).
//
// --deploy first deploys <commit> (HEAD, clean where a deploy reads it) to
// the throwaway <name>, then probes it as --target throwaway:<name> does.
// The dist gate and wrangler's bundle run on CI (scripts/ci/lib/release.mjs);
// this machine only uploads the bundle, as built, with its own wrangler
// login (_throwaway-target.mjs up --bundle), and checks the deployment by
// its id. No Cloudflare credential leaves this machine. Tear the throwaway
// down from here, which builds nothing:
// `bun tests/behavioral/_throwaway-target.mjs down --name <name>`.
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
import { fetchRelease } from './lib/release.mjs';

/** A task's limit on armada, and so the job's: every part runs at once. */
const TASK_TIMEOUT_S = 30 * 60;
/** How long a task may wait to start (a new environment preparing, a queue): past it, not graded. */
const PREPARE_S = 15 * 60;
const TOKEN_TTL_MS = (PREPARE_S + TASK_TIMEOUT_S) * 1000;

const argv = process.argv.slice(2);
const VALUED = ['--target', '--deploy', '--only', '--skip', '--parts', '--jobs', '--repeat', '--times'];
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUED.includes(argv[i]) && argv[i + 1] !== undefined) flags[argv[i].slice(2)] = argv[++i];
  else if (!argv[i].startsWith('--')) positional.push(argv[i]);
  else usage(`unexpected ${argv[i]}`);
}
const target = /^(staging|throwaway:(.+)|hosted:(https:\/\/[^/]+))$/.exec(flags.target ?? '');
if (!target === !flags.deploy || positional.length > 1) usage('one of --target staging, throwaway:<name> or hosted:<https origin>, and --deploy <name>, is required');
const hosted = target?.[3];
if (hosted && !flags.only) usage('--target hosted:<origin> runs the hosted-demo checks it is given (--only)');
const count = (name, fallback) => {
  const value = flags[name] === undefined ? fallback : Number(flags[name]);
  if (!Number.isInteger(value) || value < 1) usage(`--${name} must be a positive integer`);
  return value;
};
const parts = count('parts', 4);
const jobs = count('jobs', 4);
const times = count('times', 5);
function usage(why) {
  console.error(`${why}\nusage: bun scripts/ci/remote-probes.mjs (--target staging|throwaway:<name> | --deploy <name>) [<commit>] [--only a,b] [--skip c,d] [--parts N] [--jobs J] [--repeat a,b --times T]`);
  process.exit(2);
}

const git = (cwd, args) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || done.error?.message || '').trim()}`);
  return done.stdout.trim();
};
let repo;
let sha;
try {
  repo = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  sha = git(repo, ['rev-parse', '--verify', `${positional[0] ?? 'HEAD'}^{commit}`]);
} catch (error) {
  console.error(`remote-probes: NOT GRADED — ${error.message}`);
  process.exit(2);
}

if (flags.deploy) {
  try {
    await deploy(flags.deploy);
  } catch (error) {
    console.error(`remote-probes: NOT GRADED — ${error.message}`);
    process.exit(2);
  }
}

// A hosted demo is probed as its visitors use it, anonymously: no token, and
// no probe-target skips.
const skip = flags.skip ?? (hosted ? '' : PROBE_TARGET_SKIPS.join(','));
const throwaway = flags.deploy ?? target[2];
const minter = throwaway === undefined
  ? ['tests/behavioral/_staging-target.mjs', 'token']
  : ['tests/behavioral/_throwaway-target.mjs', 'token', '--name', throwaway];
// The latest a task may start and still end within its limit before the token
// expires; one that starts later (a slow queue, a long preparation) is not graded.
const startBy = Date.now() + TOKEN_TTL_MS - TASK_TIMEOUT_S * 1000;
const minted = hosted ? null : spawnSync('bun', [...minter, '--json', '--ttl-ms', String(TOKEN_TTL_MS)], { cwd: repo, encoding: 'utf8' });
if (minted && minted.status !== 0) {
  console.error(`remote-probes: NOT GRADED — could not mint a token for ${throwaway ?? 'staging'}:\n${minted.stderr}`);
  process.exit(2);
}
const { base, token } = minted ? JSON.parse(minted.stdout) : { base: hosted, token: null };
const scrub = (text) => (token ? text.replaceAll(token, '[NIMBUS_PROBE_TOKEN]') : text);
const items = [
  ...Array.from({ length: parts }, (_, i) => ({ task: `part ${i + 1}/${parts}`, part: `${i + 1}/${parts}`, only: flags.only ?? '', jobs })),
  ...(flags.repeat ?? '').split(',').filter(Boolean).flatMap((probe) => Array.from({ length: times }, (_, i) => ({
    task: `${probe} #${i + 1}`, part: '1/1', only: probe, jobs: 1,
  }))),
];
console.error(`remote-probes: ${items.length} tasks against ${base}, probes of ${sha.slice(0, 12)}`);

/**
 * Deploy `sha` to the throwaway `name`: a release from CI, uploaded from
 * here. Throws, saying why, when it could not.
 */
async function deploy(name) {
  if (git(repo, ['rev-parse', 'HEAD']) !== sha) throw new Error(`--deploy deploys this worktree's HEAD, and ${sha.slice(0, 12)} is not it`);
  const { dir } = await fetchRelease({ repo, sha, targets: ['apps/probe'] });
  // Its exports (a token among them) are not wanted: probes get their own, below.
  const up = spawnSync('bun', ['tests/behavioral/_throwaway-target.mjs', 'up', '--name', name, '--bundle', dir], { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'] });
  if (up.status !== 0) throw new Error(`the upload of the release to ${name} failed (exit ${up.status}); the release is in ${dir}`);
}

let mapped;
try {
  mapped = await mapOnArmada({
    repo, sha, files: ['scripts/ci/probes.mjs', 'tests/behavioral/run-all.mjs'], setup: 'scripts/ci/recipe/chromium.sh',
    items, env: token ? { NIMBUS_PROBE_TOKEN: token } : {}, label: `remote-probes ${sha.slice(0, 12)} ${throwaway ?? hosted ?? 'staging'}`, timeout: TASK_TIMEOUT_S,
    command: ['bun', 'scripts/ci/probes.mjs', '--out', '{out}', '--base', base, '--only', '{only}', '--skip', skip, '--part', '{part}', '--jobs', '{jobs}',
      ...(token ? ['--start-by', String(startBy)] : ['--anonymous'])],
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
try {
  mkdirSync(state, { recursive: true });
  const report = join(state, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${sha.slice(0, 12)}-${mapped.jobId}.json`);
  writeFileSync(report, `${scrub(JSON.stringify({ commit: sha, target: throwaway ? `throwaway:${throwaway}` : hosted ? `hosted:${hosted}` : 'staging', base, job: mapped.jobId, tasks }, null, 2))}\n`);
  console.log(`remote-probes: ${status === 0 ? 'every row green' : status === 1 ? 'red rows above' : 'not every task was graded'}; verdict ${report} (job ${mapped.jobId})`);
  process.exit(status);
} catch (error) {
  console.error(`remote-probes: NOT GRADED — the verdict could not be kept: ${scrub(error.message)}`);
  process.exit(2);
}
