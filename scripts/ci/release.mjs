#!/usr/bin/env bun
// A commit to staging, built on CI and verified there: the release
// production is later promoted from (scripts/ci/promote.mjs).
//
//   bun scripts/ci/release.mjs staging [<commit>] [--rotate-secrets] [--no-matrix] [--repeat a,b --times T]
//
// Run it in a clean worktree at <commit> (default HEAD): the upload reads
// the apps' wrangler configs and the worker's public assets from it.
//   1. CI builds the release (scripts/ci/lib/release.mjs): the dist gate,
//      the demo's assets, and the modules of apps/probe and of
//      apps/hosted-demo for env.staging and env.production, which must be
//      the same bytes.
//   2. This machine uploads it, as built, to nimbus-probe-staging and
//      nimbus-staging (tests/behavioral/_staging-target.mjs up --release),
//      after deploy-isolation's preflight, and verifies each version id.
//   3. The staging matrix, from containers (scripts/ci/remote-probes.mjs),
//      graded row by row (scripts/ci/lib/matrix.mjs): green only if every
//      red row is a probe the user deferred (tests/behavioral/_deferred.mjs)
//      and every deferred probe ran and failed:
//      the whole suite with Chromium against nimbus-probe-staging, the
//      write-heavy probes whose failure is intermittent repeated beside it,
//      then the hosted-demo checks against nimbus-staging as a visitor
//      reaches it (HOSTED_DEMO_CHECKS: /try, the docs terminal).
// Staging is leased from the upload through the matrix (lib/lease.mjs), and
// the matrix counts only if staging served this upload from its first probe
// to its last (version ids read before and after; otherwise not graded).
// staged.json records the versions, the matrix's verdict and the digest of
// the whole release manifest; promote.mjs promotes only a release whose
// matrix was green, and only if its manifest still has that digest.
// Exit: 0, staged and the matrix green; 1, a red row or a failed upload;
// 2, not graded.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFERRED } from '../../tests/behavioral/_deferred.mjs';
import { HOSTED_DEMO_CHECKS } from '../../tests/behavioral/_probe-target-skips.mjs';
import { gradeMatrix } from './lib/matrix.mjs';
import { assertInstalled } from './lib/installed.mjs';

/** Write-heavy probes repeated beside the suite: their failure mode is intermittent. */
const REPEATED = ['python/flask-markupsafe-fallback', 'python/numpy-flask-startup-modules', 'node/entry-pending-work'];

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (['--rotate-secrets', '--no-matrix'].includes(argv[i])) flags[argv[i].slice(2)] = true;
  else if (['--repeat', '--times'].includes(argv[i]) && argv[i + 1] !== undefined) flags[argv[i].slice(2)] = argv[++i];
  else if (!argv[i].startsWith('--')) positional.push(argv[i]);
  else usage(`unexpected ${argv[i]}`);
}
if (positional[0] !== 'staging' || positional.length > 2) usage('the one environment a release goes to from here is staging');
function usage(why) {
  console.error(`${why}\nusage: bun scripts/ci/release.mjs staging [<commit>] [--rotate-secrets] [--no-matrix] [--repeat a,b --times T]`);
  process.exit(2);
}

const notGraded = (why) => {
  console.error(`release: NOT GRADED — ${why}`);
  process.exit(2);
};
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
if (top.status !== 0) notGraded(`not in a git checkout: ${top.stderr.trim()}`);
const repo = top.stdout.trim();
const resolved = git(repo, ['rev-parse', '--verify', `${positional[1] ?? 'HEAD'}^{commit}`]);
if (resolved.status !== 0) notGraded(`no commit ${positional[1] ?? 'HEAD'}`);
const sha = resolved.stdout.trim();
if (git(repo, ['rev-parse', 'HEAD']).stdout.trim() !== sha) notGraded(`${sha.slice(0, 12)} is not this worktree's HEAD: the upload reads the checkout`);
if (!process.env.CLOUDFLARE_ACCOUNT_ID) notGraded('CLOUDFLARE_ACCOUNT_ID is not set: the deploy pins the account');
assertInstalled(repo, 'release');
// Imported once the install is known to be here: the upload path parses wrangler configs through it.
const { fetchRelease, releaseDigest } = await import('./lib/release.mjs');
const { holdLease } = await import('./lib/lease.mjs');

let dir;
let release;
try {
  ({ dir, release } = await fetchRelease({ repo, sha, targets: ['apps/probe', 'apps/hosted-demo:staging', 'apps/hosted-demo:production'] }));
} catch (error) {
  notGraded(error.message);
}

// The staging lease, from the upload through the matrix: no other lane's
// upload lands while this matrix grades this release (scripts/ci/lib/lease.mjs).
let leaseFd;
try {
  leaseFd = holdLease('staging', { what: { commit: sha, worktree: repo } });
} catch (error) {
  notGraded(error.message);
}

/** What staging serves now (_staging-target status --json). */
function serving() {
  const status = spawnSync('bun', ['tests/behavioral/_staging-target.mjs', 'status', '--json'], { cwd: repo, encoding: 'utf8' });
  if (status.status !== 0) notGraded(`could not read what staging serves:\n${status.stderr}`);
  return JSON.parse(status.stdout);
}

// The upload holds the lease too (its fd 3, and its writers', should this
// process die first), and writes its own receipt: the version ids wrangler
// returned to this upload. Its exports (a token among them) are not wanted here.
const receipt = join(dir, 'staging-receipt.json');
const up = spawnSync('bun', ['tests/behavioral/_staging-target.mjs', 'up', '--release', dir, '--receipt', receipt, ...(flags['rotate-secrets'] ? ['--rotate-secrets'] : [])], {
  cwd: repo, stdio: ['ignore', 'ignore', 'inherit', leaseFd],
});
if (up.status !== 0) {
  console.log(`release: the upload to staging failed (exit ${up.status}); the release is in ${dir}`);
  process.exit(1);
}
// Sealed with the whole manifest: promote.mjs promotes exactly what this matrix graded.
const staged = { commit: sha, at: new Date().toISOString(), release: releaseDigest(release), versions: {}, matrix: null };
const uploaded = JSON.parse(readFileSync(receipt, 'utf8'));
for (const [name, row] of Object.entries(serving())) {
  if (!uploaded[name] || row.live !== uploaded[name]) notGraded(`${name} serves ${row.live}, not this upload's ${uploaded[name]}`);
  staged.versions[name] = { version: uploaded[name], base: row.base };
}
console.log(`release: staging serves ${Object.entries(staged.versions).map(([name, { version }]) => `${name} ${version}`).join(', ')}, this upload`);

/** remote-probes with `args`, its report passed through; resolves to its exit code and verdict. */
function probes(args) {
  const run = spawnSync('bun', ['scripts/ci/remote-probes.mjs', ...args, sha], {
    cwd: repo, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 30,
  });
  process.stdout.write(run.stdout);
  return { exitCode: run.status ?? 2, verdict: /verdict (\S+\.json)/.exec(run.stdout)?.[1] ?? null };
}

let exit = 0;
if (!flags['no-matrix']) {
  const repeat = flags.repeat ?? REPEATED.join(',');
  const suite = probes(['--target', 'staging', ...(repeat ? ['--repeat', repeat, '--times', flags.times ?? '5'] : [])]);
  const demo = staged.versions['nimbus-staging']?.base;
  const hosted = demo ? probes(['--target', `hosted:${new URL(demo).origin}`, '--only', HOSTED_DEMO_CHECKS.join(','), '--parts', '1', '--jobs', String(HOSTED_DEMO_CHECKS.length)])
    : { exitCode: 2, verdict: null };
  // Graded row by row against the user's deferrals (lib/matrix.mjs): green
  // only if every red row is a deferred probe's, and every deferred probe
  // ran and failed. A deferred probe's rows, output included, are kept here.
  const read = (path) => { try { return path ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; } };
  const graded = gradeMatrix([read(suite.verdict), read(hosted.verdict)], DEFERRED);
  staged.matrix = { exitCode: graded.exitCode, suite, hosted, deferrals: graded.applied, problems: graded.problems };
  for (const entry of graded.applied) {
    console.log(`release: DEFERRED ${entry.probe} — red in ${entry.rows.length} row${entry.rows.length === 1 ? '' : 's'}, shipped by deferral of ✗ ${entry.assertion} with HTTP ${entry.failure.status} "${entry.failure.title}" only: ${entry.reason} (approved ${entry.approved}; owner ${entry.owner}; tracking ${entry.tracking})`);
  }
  for (const problem of graded.problems) console.log(`release: ${problem}`);
  // The matrix graded this upload only if staging served it throughout.
  const moved = Object.entries(serving()).filter(([name, row]) => row.live !== staged.versions[name]?.version);
  if (moved.length > 0) {
    staged.matrix.exitCode = 2;
    staged.matrix.moved = Object.fromEntries(moved.map(([name, row]) => [name, row.live]));
    console.log(`release: NOT GRADED — staging changed under the matrix: ${moved.map(([name, row]) => `${name} now serves ${row.live}, not ${staged.versions[name]?.version}`).join('; ')}`);
  }
  exit = staged.matrix.exitCode;
}
writeFileSync(join(dir, 'staged.json'), `${JSON.stringify(staged, null, 2)}\n`);
const deferrals = staged.matrix?.deferrals?.length ? ` with ${staged.matrix.deferrals.length} deferral${staged.matrix.deferrals.length === 1 ? '' : 's'} (${staged.matrix.deferrals.map((entry) => entry.probe).join(', ')})` : '';
console.log(`release: ${sha.slice(0, 12)} staged${staged.matrix ? `, matrix ${staged.matrix.exitCode === 0 ? `green${deferrals}` : staged.matrix.exitCode === 2 ? 'NOT GRADED' : 'RED'}` : ', matrix not run'}; ${join(dir, 'staged.json')}`);
process.exit(exit);
