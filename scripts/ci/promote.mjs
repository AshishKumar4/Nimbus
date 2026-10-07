#!/usr/bin/env bun
// Promote one release to production: the module and assets staging verified,
// uploaded as built, then proven live.
//
//   CLOUDFLARE_ACCOUNT_ID=… bun scripts/ci/promote.mjs <commit> [--release <dir>] [--dry-run]
//
// Run it in a clean worktree at <commit>: the upload reads the demo's
// wrangler config and the worker's public assets from it.
//   1. The release: the newest under ~/.local/state/nimbus/releases/ for
//      <commit> whose staging matrix was green (release.mjs staging wrote its
//      staged.json), or --release <dir>. Production's module must be the
//      bytes staging served: its sha256 is checked against the one staged.json
//      recorded, then against the file (scripts/ci/lib/release.mjs), and the
//      assets against CI's manifest, file by file.
//   2. deploy-isolation's preflight (scripts/deploy-isolation.mjs).
//   3. The upload, `wrangler deploy --no-bundle -e production`, verified by
//      version id: printed, served, and not the one served before.
//   4. The live checks, from containers, against https://nimbus-os.dev as a
//      visitor reaches it (HOSTED_DEMO_CHECKS and PRODUCTION_ONLY_CHECKS:
//      /try, the docs terminal, host-form previews).
// On a failed check it prints the rollback to the version served before.
// --dry-run does 1 and 2, reads the version production serves, writes the
// upload config, and stops.
// Exit: 0, live and every check green; 1, a failed upload or check; 2, not
// graded (nothing was uploaded).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOSTED_DEMO_CHECKS, PRODUCTION_ONLY_CHECKS } from '../../tests/behavioral/_probe-target-skips.mjs';
import { assertInstalled } from './lib/installed.mjs';

const PRODUCTION = { name: 'nimbus', env: 'production', app: 'apps/hosted-demo', origin: 'https://nimbus-os.dev' };

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dry-run') flags['dry-run'] = true;
  else if (argv[i] === '--release' && argv[i + 1] !== undefined) flags.release = argv[++i];
  else if (!argv[i].startsWith('--')) positional.push(argv[i]);
  else usage(`unexpected ${argv[i]}`);
}
if (positional.length !== 1) usage('one commit');
function usage(why) {
  console.error(`${why}\nusage: CLOUDFLARE_ACCOUNT_ID=… bun scripts/ci/promote.mjs <commit> [--release <dir>] [--dry-run]`);
  process.exit(2);
}

const log = (line) => console.error(`[promote] ${line}`);
const notGraded = (why) => {
  console.error(`promote: NOT GRADED, nothing uploaded — ${why}`);
  process.exit(2);
};
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
if (top.status !== 0) notGraded(`not in a git checkout: ${top.stderr.trim()}`);
const repo = top.stdout.trim();
const resolved = git(repo, ['rev-parse', '--verify', `${positional[0]}^{commit}`]);
if (resolved.status !== 0) notGraded(`no commit ${positional[0]}`);
const sha = resolved.stdout.trim();
if (git(repo, ['rev-parse', 'HEAD']).stdout.trim() !== sha) notGraded(`${sha.slice(0, 12)} is not this worktree's HEAD: the upload reads the checkout`);
const dirty = git(repo, ['status', '--porcelain', '--untracked-files=all']).stdout;
if (dirty) notGraded(`the worktree is not clean:\n${dirty}`);
assertInstalled(repo, 'promote');
const { RELEASES, readRelease, uploadConfig } = await import('./lib/release.mjs');
const { activeVersionId, deployAndVerify, requireAccountPin } = await import('../../tests/behavioral/_deploy-target.mjs');
const account = requireAccountPin();

// 1. The release staging verified.
const staged = (dir) => {
  const path = join(dir, 'staged.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};
const candidates = flags.release ? [flags.release]
  : (existsSync(RELEASES) ? readdirSync(RELEASES).map((name) => join(RELEASES, name)) : [])
    .filter((dir) => existsSync(join(dir, 'release.json')) && readRelease(dir).commit === sha)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const dir = candidates.find((candidate) => staged(candidate)?.matrix?.exitCode === 0);
if (!dir) {
  notGraded(`no release of ${sha.slice(0, 12)} whose staging matrix was green${candidates.length ? ` (${candidates.map((candidate) => `${candidate}: ${staged(candidate) ? `matrix ${staged(candidate).matrix ? `exit ${staged(candidate).matrix.exitCode}` : 'not run'}` : 'never staged'}`).join('; ')})` : ''}: run \`bun scripts/ci/release.mjs staging\` first`);
}
const release = readRelease(dir);
const target = `${PRODUCTION.app}:${PRODUCTION.env}`;
const servedOnStaging = staged(dir).modules[`${PRODUCTION.app}:staging`];
if (!release.bundles[target] || release.bundles[target].sha256 !== servedOnStaging) {
  notGraded(`production's module (${release.bundles[target]?.sha256 ?? 'none'}) is not the one staging served (${servedOnStaging})`);
}
log(`release ${dir}: ${target} sha256 ${servedOnStaging}, the bytes staging served (matrix green ${staged(dir).at})`);

// 2. The preflight.
const isolation = spawnSync('bun', ['scripts/deploy-isolation.mjs'], { cwd: repo, encoding: 'utf8' });
if (isolation.status !== 0) notGraded(`deploy-isolation refused:\n${isolation.stdout}${isolation.stderr}`);
log('deploy-isolation: every non-production target resolves no production resource');

let config;
try {
  config = uploadConfig(dir, target, { root: repo, log });
} catch (error) {
  notGraded(error.message);
}
const cwd = join(repo, PRODUCTION.app);
const before = activeVersionId(PRODUCTION.name, { cwd, account });
if (!before) notGraded(`cannot read the version ${PRODUCTION.name} serves now`);
const rollback = `bun run --cwd ${PRODUCTION.app} wrangler versions deploy --name ${PRODUCTION.name} ${before}@100% -e ${PRODUCTION.env}`;
log(`${PRODUCTION.name} serves ${before} (rollback: ${rollback})`);
if (flags['dry-run']) {
  console.log(`promote: dry run — would upload ${config} as ${PRODUCTION.name} (env.${PRODUCTION.env}) over ${before}`);
  process.exit(0);
}

// 3. The upload.
let versionId;
try {
  ({ versionId } = deployAndVerify({ cwd, account, name: PRODUCTION.name, envName: PRODUCTION.env, args: ['--config', config] }));
} catch (error) {
  console.log(`promote: the upload failed — ${error.message}\n  production may still serve ${before}; to be sure: ${rollback}`);
  process.exit(1);
}
log(`${PRODUCTION.name} → version ${versionId}, verified served`);

// 4. The live checks.
const checks = [...HOSTED_DEMO_CHECKS, ...PRODUCTION_ONLY_CHECKS];
const live = spawnSync('bun', ['scripts/ci/remote-probes.mjs', '--target', `hosted:${PRODUCTION.origin}`, sha, '--only', checks.join(','), '--parts', '1', '--jobs', String(checks.length)], {
  cwd: repo, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 30,
});
process.stdout.write(live.stdout);
const promoted = { commit: sha, at: new Date().toISOString(), before, versionId, module: servedOnStaging, live: { exitCode: live.status, verdict: /verdict (\S+\.json)/.exec(live.stdout)?.[1] ?? null } };
writeFileSync(join(dir, 'promoted.json'), `${JSON.stringify(promoted, null, 2)}\n`);
if (live.status !== 0) {
  console.log(`promote: ${PRODUCTION.name} serves ${versionId}, and the live checks are not green (exit ${live.status}). Roll back: ${rollback}`);
  process.exit(1);
}
console.log(`promote: ${sha.slice(0, 12)} is live as ${versionId}, every check green; ${join(dir, 'promoted.json')}`);
