#!/usr/bin/env bun
// Deploy nimbus-ci-runner: stage the image context, make sure its bucket and
// token exist, and `wrangler deploy` (which builds the image with the local
// docker and pushes it to Cloudflare's registry).
//
//   bun apps/ci-runner/scripts/deploy.mjs [--deps-ref main] [--rotate-token]
//
// --deps-ref   the ref whose bun.lock and manifests warm the image's bun
//              cache (default main). A shard installs its own commit's
//              lockfile either way; this only decides what is cached.
// --rotate-token  mint a new CI token, store it in ~/.config/nimbus/ci-token
//              and as the Worker's CI_TOKEN secret. Without it an existing
//              token is kept, and one is minted only when none exists.
//
// Docker must be running: wrangler builds the Dockerfile locally.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCOUNT = 'f44999d1ddda7012e9a87729eba250f1';
const BUCKET = 'nimbus-ci-artifacts';
const WORKER = 'nimbus-ci-runner';
export const TOKEN_FILE = join(homedir(), '.config/nimbus/ci-token');

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(app, '../..');
const context = join(app, '.image-context');
const wrangler = join(repo, 'node_modules/.bin/wrangler');
const depsRef = process.argv.includes('--deps-ref') ? process.argv[process.argv.indexOf('--deps-ref') + 1] : 'main';

if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT) {
  console.error(`FATAL: CLOUDFLARE_ACCOUNT_ID is ${process.env.CLOUDFLARE_ACCOUNT_ID}; ${WORKER} lives in ${ACCOUNT}`);
  process.exit(2);
}
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const wr = (args, options = {}) => spawnSync(wrangler, args, { cwd: app, env, encoding: 'utf8', ...options });

/** Every file under `root`, relative, sorted. */
function listFiles(root, dir = '') {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? listFiles(root, join(dir, entry.name)) : [join(dir, entry.name)]))
    .sort();
}

// ── Image context ────────────────────────────────────────────────────
rmSync(context, { recursive: true, force: true });
mkdirSync(join(context, 'deps'), { recursive: true });
cpSync(join(app, 'image/Dockerfile'), join(context, 'Dockerfile'));
cpSync(join(app, 'image/ci'), join(context, 'ci'), { recursive: true });
const manifests = git('ls-tree', '-r', '--name-only', depsRef).split('\n')
  .filter((path) => path === 'bun.lock' || path === 'bunfig.toml' || /^(package\.json|(apps|packages)\/[^/]+\/package\.json)$/.test(path));
for (const path of manifests) {
  mkdirSync(dirname(join(context, 'deps', path)), { recursive: true });
  writeFileSync(join(context, 'deps', path), git('show', `${depsRef}:${path}`));
}
writeFileSync(join(context, 'lean-toolchain'), git('show', `${depsRef}:lean/lean-toolchain`));
// This checkout's runner, laid over a commit that predates sharding (image/ci/shard.mjs).
for (const file of ['tests/unit/run-all.mjs', 'tests/unit/lib/partition.mjs', 'scripts/lib/bounded-process.mjs', 'scripts/lib/subprocess-entry.mjs']) {
  mkdirSync(dirname(join(context, 'ci/runner', file)), { recursive: true });
  cpSync(join(repo, file), join(context, 'ci/runner', file));
}
// The image's build id: a hash of everything it is built from. The Worker
// gets the same id as CI_IMAGE_BUILD, and a shard refuses a container whose
// /opt/ci/BUILD differs: a rollout reaches prepared instances over minutes,
// and a run must not grade a commit on the image it was meant to replace.
const hash = createHash('sha256');
for (const path of listFiles(context)) hash.update(`${path}\0`).update(readFileSync(join(context, path))).update('\0');
const build = hash.digest('hex').slice(0, 16);
writeFileSync(join(context, 'ci/BUILD'), `${build}\n`);
console.error(`ci-runner deploy: image context staged (${manifests.length} manifests from ${depsRef}), build ${build}`);

// ── Bucket ───────────────────────────────────────────────────────────
// `r2 bucket list` is paginated (20 per page); `info` answers for one bucket.
if (wr(['r2', 'bucket', 'info', BUCKET]).status !== 0) {
  const made = wr(['r2', 'bucket', 'create', BUCKET], { stdio: 'inherit' });
  if (made.status !== 0) process.exit(made.status ?? 1);
}
// Sources, logs and reports expire after 7 days (the timing history is CiTimings').
const rules = wr(['r2', 'bucket', 'lifecycle', 'list', BUCKET]).stdout ?? '';
for (const prefix of ['sources/', 'runs/']) {
  const id = `expire-${prefix.slice(0, -1)}`;
  if (rules.includes(id)) continue;
  const added = wr(['r2', 'bucket', 'lifecycle', 'add', BUCKET, id, prefix, '--expire-days', '7', '--force'], { stdio: 'inherit' });
  if (added.status !== 0) process.exit(added.status ?? 1);
}

// ── Deploy ───────────────────────────────────────────────────────────
// An unchanged image is not rolled out again: a rollout replaces the
// prepared instances, and shards started meanwhile wait for capacity.
const live = await fetch(`https://${WORKER}.ashishkmr472.workers.dev/health`).then((r) => r.text()).catch(() => '');
const sameImage = live.trim() === `ok ${build}`;
if (sameImage) console.error(`ci-runner deploy: image ${build} is live already; deploying the Worker alone`);
const deployed = wr(['deploy', '--var', `CI_IMAGE_BUILD:${build}`, ...(sameImage ? ['--containers-rollout', 'none'] : [])], { stdio: 'inherit' });
if (deployed.status !== 0) process.exit(deployed.status ?? 1);

// A new image rolls out to the prepared instances over minutes; a run
// started meanwhile waits for capacity, and containers lost connection in
// the first minutes after an image deploy (6 of 16 shards, 2026-10-06).
// Return once the rollout is done.
const application = sameImage ? null : JSON.parse(wr(['containers', 'list', '--json']).stdout || '[]').find((a) => a.name === `${WORKER}-cishard`);
if (application) {
  for (const started = Date.now(); Date.now() - started < 30 * 60_000;) {
    const info = JSON.parse(wr(['containers', 'info', application.id]).stdout.replace(/^[^{]*/, '') || '{}');
    if (!info.active_rollout_id) break;
    console.error(`ci-runner deploy: rollout ${info.active_rollout_id} in progress (${JSON.stringify(info.health?.instances ?? {})})`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
}

// ── Token ────────────────────────────────────────────────────────────
const secrets = wr(['secret', 'list', '--format', 'json']);
const hasSecret = secrets.status === 0 && JSON.parse(secrets.stdout || '[]').some((s) => s.name === 'CI_TOKEN');
if (process.argv.includes('--rotate-token') || !existsSync(TOKEN_FILE) || !hasSecret) {
  const token = !process.argv.includes('--rotate-token') && existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : randomBytes(32).toString('hex');
  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  const put = wr(['secret', 'put', 'CI_TOKEN'], { input: token, stdio: ['pipe', 'inherit', 'inherit'] });
  if (put.status !== 0) process.exit(put.status ?? 1);
  console.error(`ci-runner deploy: CI_TOKEN set; the token is in ${TOKEN_FILE}`);
}
console.error(`ci-runner deploy: done. Run: bun scripts/ci-run.mjs HEAD`);
