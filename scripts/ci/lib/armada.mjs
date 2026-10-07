// The one place Nimbus reaches armada (Cloudflare Containers): a lane's
// commit, with this checkout's CI files laid over it, mapped over items in
// containers, and each task's {out} fetched back. The commands it runs are
// backend-neutral (scripts/ci/build.mjs, scripts/ci/probes.mjs); only this
// file knows armada.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The armada client, pinned: exactly ARMADA_CLIENT, a clean checkout of it
// at ARMADA_DIR (a detached worktree of PreparedSkunk's armada clone, its
// node_modules from `bun install --frozen-lockfile --production`), or the
// run is refused. Upstream (/mnt/local/armada, eeef535) packs a commit
// without the trees the environment's ancestors share with it, which no
// environment holds ("fatal: unable to read tree"); 17db0d5 fixes it, and
// ARMADA_CLIENT is the latest commit proven on top of it. Only the client
// differs: it talks to the same deployed armada.
const ARMADA_DIR = '/mnt/local/nimbus/armada-client';
const ARMADA_CLIENT = '1a91f1bf5897cc4fb47cc04437973f73ef2e7195';

/** The armada recipe every task needs, whatever the lane's commit has. */
export const RECIPE = ['.armada.json', 'scripts/armada/setup.sh', 'scripts/armada/install.sh'];

const git = (cwd, args, options = {}) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, ...options });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || done.error?.message || '').trim()}`);
  return done.stdout.trim();
};

/**
 * A commit object, on no branch, whose tree is `sha`'s with each `files`
 * path replaced by the bytes and executable bit it has under `from` (or by
 * the `{ path, bytes }` given, as a plain file). Its
 * parent is `sha`. Each call makes a new one (its date is now): armada keeps
 * the pack it was sent for a commit, so a commit reused across runs would
 * reuse a pack that was wrong once.
 */
export function overlayCommit(repo, sha, files, from = SELF_ROOT) {
  const scratch = mkdtempSync(join(tmpdir(), 'armada-overlay-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
    git(repo, ['read-tree', sha], { env });
    for (const file of files) {
      const path = typeof file === 'string' ? file : file.path;
      const blob = git(repo, ['hash-object', '-w', '--stdin'], { input: typeof file === 'string' ? readFileSync(join(from, path)) : file.bytes });
      const mode = typeof file === 'string' && statSync(join(from, path)).mode & 0o100 ? '100755' : '100644';
      git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], { env });
    }
    const tree = git(repo, ['write-tree'], { env });
    const date = new Date().toISOString();
    return git(repo, ['commit-tree', tree, '-p', sha, '-m', `armada run of ${sha} at ${date}`], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Nimbus CI', GIT_AUTHOR_EMAIL: 'ci@nimbus.invalid',
        GIT_COMMITTER_NAME: 'Nimbus CI', GIT_COMMITTER_EMAIL: 'ci@nimbus.invalid',
      },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Map `command` over `items` on `sha` (run from its repo), with `files`
 * laid over its tree. `setup`, a script path here, is appended to the
 * recipe's setup script for this job: an environment of its own (its key
 * is the setup text), so what only some tasks need is not in every
 * container. armada runs setup before it checks the commit out, so the
 * script cannot be run from the checkout; it is joined here.
 * `env` joins the recipe's for this job only: armada
 * keeps a job's spec while the job lives, so a credential put here must be
 * one minted for this run and short-lived. Interrupting the process cancels
 * the job. The commit made for it is held by a ref of its own
 * (refs/nimbus-ci/) until the job is done, so no prune can take it while
 * armada packs it. Resolves to that commit, each outcome in item order and
 * each task's {out} text (null when it wrote none); throws when the job
 * could not be started.
 *
 * @param {{ repo: string, sha: string, files: string[], setup?: string, items: unknown[], command: string[], env?: Record<string, string>,
 *   label: string, pool?: number, timeout?: number, log?: (line: string) => void }} options
 */
export async function mapOnArmada({ repo, sha, files, setup, items, command, env = {}, label, pool = items.length, timeout = 3600, log = (line) => console.error(line) }) {
  const armadaDir = process.env.ARMADA_DIR || ARMADA_DIR;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: armadaDir, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: armadaDir, encoding: 'utf8' });
  if (head.status !== 0 || head.stdout.trim() !== ARMADA_CLIENT || dirty.status !== 0 || dirty.stdout !== '') {
    throw new Error(`the armada client must be a clean checkout of ${ARMADA_CLIENT} at ${armadaDir}; it is ${head.status === 0 ? head.stdout.trim() : 'not a checkout'}${dirty.stdout ? ', with local changes' : ''}. `
      + `Make one: git -C <PreparedSkunk's armada clone> worktree add --detach ${armadaDir} ${ARMADA_CLIENT}, then bun install --frozen-lockfile --production in it`);
  }
  const { connect } = await import(join(armadaDir, 'src', 'sdk.ts'));
  const { onCommit } = await import(join(armadaDir, 'src', 'ci.ts'));
  const overlay = [...RECIPE, ...files];
  if (setup) {
    // The commit's .armada.json names the environment armada packs for: one
    // whose setup is the recipe's with `setup` after it.
    const config = JSON.parse(readFileSync(join(SELF_ROOT, '.armada.json'), 'utf8'));
    const joined = `${config.environment.setup.replace(/\.sh$/, '')}+${setup.split('/').at(-1)}`;
    const text = `${readFileSync(join(SELF_ROOT, config.environment.setup), 'utf8')}\n${readFileSync(join(SELF_ROOT, setup), 'utf8')}`;
    overlay.splice(0, 1,
      { path: '.armada.json', bytes: `${JSON.stringify({ ...config, environment: { ...config.environment, setup: joined } }, null, 2)}\n` },
      { path: joined, bytes: text });
  }
  const commit = overlayCommit(repo, sha, overlay);
  const ref = `refs/nimbus-ci/${randomUUID()}`;
  git(repo, ['update-ref', ref, commit]);
  // An interrupt exits from the cancel handler, past the finally below.
  const dropRef = () => spawnSync('git', ['update-ref', '-d', ref], { cwd: repo });
  process.once('exit', dropRef);
  try {
    log(`armada: ${sha.slice(0, 12)} as ${commit.slice(0, 12)} (its tree plus ${overlay.map((file) => (typeof file === 'string' ? file : file.path)).join(', ')})`);
    return { commit, ...await runJob({ armada: connect(), onCommit, repo, commit, items, command, env, label, pool, timeout, log }) };
  } finally {
    process.off('exit', dropRef);
    dropRef();
  }
}

/** The job itself: started, followed, cancelled with this process, and read back. */
async function runJob({ armada, onCommit, repo, commit, items, command, env, label, pool, timeout, log }) {
  // armada resolves the commit in the working directory's repository.
  const cwd = process.cwd();
  process.chdir(repo);
  let where;
  try {
    where = await onCommit(armada, commit);
  } finally {
    process.chdir(cwd);
  }
  const job = await armada.map({ ...where, env: { ...where.env, ...env }, items, run: { command }, output: true, pool, timeout, label });
  log(`armada: job ${job.id}`);
  const cancel = () => { job.cancel().finally(() => process.exit(130)); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let phase = '';
  const watcher = setInterval(() => {
    job.status().then((status) => {
      if (status.phase === phase) return;
      phase = status.phase;
      log(`armada: ${phase === 'preparing' ? `preparing environment ${status.key.slice(0, 12)} (minutes, once per recipe and lockfile)` : phase}`);
    }, () => {});
  }, 5_000);
  const outcomes = [];
  try {
    for await (const outcome of job.outcomes()) outcomes.push(outcome);
  } finally {
    clearInterval(watcher);
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
  outcomes.sort((a, b) => a.index - b.index);
  const outputs = await Promise.all(outcomes.map((outcome) => job.output(outcome.index)));
  return { jobId: job.id, outcomes, outputs };
}
