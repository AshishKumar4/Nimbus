// The one place Nimbus reaches armada (Cloudflare Containers): a lane's
// commit, with this checkout's CI files laid over it, mapped over items in
// containers, and each task's {out} fetched back. The commands it runs are
// backend-neutral (scripts/ci/build.mjs, scripts/ci/probes.mjs); only this
// file knows armada.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The armada client, pinned: exactly ARMADA_CLIENT, a commit on main of
// ARMADA_REPO, as a clean checkout at ARMADA_DIR with its node_modules from
// `bun install --frozen-lockfile --production`, or the run is refused. The
// pin is checked against that main on every run, so a history rewritten
// under it fails loudly rather than running a client no one can fetch. The
// pin is the client the deployed Worker is proven with: move both together.
const ARMADA_DIR = join(homedir(), '.local/share/nimbus/armada-client');
export const ARMADA_REPO = 'https://github.com/AshishKumar4/armada';
export const ARMADA_CLIENT = 'f46fb8c74c893854f1e8c46993048bdc33d6a8a0';

// Nimbus's own armada deployment (`nimbus-armada`, its own Worker, bucket
// and fleet cap): every Nimbus script reaches it, and only it, through here.
// ARMADA_URL and ARMADA_TOKEN override it (the GitHub unit job has them as
// secrets); otherwise ARMADA_CONNECTION, defaulting to its connection file.
// The token is in that file and is never printed.
export const ARMADA_CONNECTION = join(homedir(), '.config', 'armada', 'nimbus-armada.json');

/**
 * The environment an armada client (the SDK here, or the CLI a script
 * spawns) connects with: Nimbus's armada, unless ARMADA_URL and
 * ARMADA_TOKEN name another.
 */
export function armadaEnv(env = process.env) {
  if (env.ARMADA_URL && env.ARMADA_TOKEN) return env;
  return { ...env, ARMADA_CONNECTION: env.ARMADA_CONNECTION || ARMADA_CONNECTION };
}

/**
 * A file laid over a commit's tree: a path whose bytes and executable bit
 * are taken from this checkout, or the bytes given for a path.
 * @typedef {string | { path: string, bytes: string | Uint8Array }} OverlayFile
 */

/** The armada recipe every task needs, whatever the lane's commit has. */
export const RECIPE = ['.armada.json', 'scripts/ci/recipe/setup.sh', 'scripts/ci/recipe/install.sh'];

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
 *
 * @param {string} repo
 * @param {string} sha
 * @param {OverlayFile[]} files
 * @param {string} [from]
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
 * The pinned armada client's directory, or a throw saying what is wrong:
 * a clean checkout of exactly ARMADA_CLIENT at ARMADA_DIR, and
 * ARMADA_CLIENT on main of ARMADA_REPO as that repository has it now.
 *
 * @param {{ dir?: string, repo?: string, pin?: string }} [where] what to check instead (a test's)
 */
export function armadaClient({ dir = process.env.ARMADA_DIR || ARMADA_DIR, repo = ARMADA_REPO, pin = ARMADA_CLIENT } = {}) {
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  const head = run(['rev-parse', 'HEAD']);
  const dirty = run(['status', '--porcelain']);
  if (head.status !== 0 || head.stdout.trim() !== pin || dirty.status !== 0 || dirty.stdout !== '') {
    throw new Error(`the armada client must be a clean checkout of ${pin} at ${dir}; it is ${head.status === 0 ? head.stdout.trim() : 'not a checkout'}${dirty.stdout ? ', with local changes' : ''}. `
      + `Make one: git clone ${repo} ${dir}, git -C ${dir} checkout --detach ${pin}, then bun install --frozen-lockfile --production in it`);
  }
  // Every lane checks against this one client checkout at once: each check
  // fetches main into a ref of its own, never FETCH_HEAD, which concurrent
  // fetches overwrite (a lane then read another lane's fetch, or none, and
  // was told the history was rewritten). Only a merge-base that answers
  // "not an ancestor" says so; anything else that fails is not graded.
  const ref = `refs/nimbus/pin-check/${process.pid}-${randomUUID()}`;
  const quiet = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
  try {
    const fetched = run([...quiet, 'fetch', '--quiet', '--no-write-fetch-head', repo, `+main:${ref}`]);
    if (fetched.status !== 0) throw new Error(`could not fetch main of ${repo} to check the pin (not graded; run again): ${fetched.stderr.trim()}`);
    const onMain = run(['merge-base', '--is-ancestor', pin, ref]);
    if (onMain.status === 1) {
      throw new Error(`the pinned armada client ${pin} is not on main of ${repo} (now ${run(['rev-parse', ref]).stdout.trim()}): its history was rewritten under the pin. Re-pin ARMADA_CLIENT in scripts/ci/lib/armada.mjs to a commit on that main`);
    }
    if (onMain.status !== 0) throw new Error(`could not check the pin ${pin} against main of ${repo} (not graded; run again): ${onMain.stderr.trim()}`);
  } finally {
    run([...quiet, 'update-ref', '-d', ref]);
  }
  return dir;
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
 * (refs/nimbus-armada/) until the job is done, so no prune can take it while
 * armada packs it. Resolves to that commit, each outcome in item order and
 * each task's {out} text (null when it wrote none); throws when the job
 * could not be started.
 *
 * @param {{ repo: string, sha: string, files: string[], setup?: string, items: unknown[], command: string[], env?: Record<string, string>,
 *   label: string, pool?: number, timeout?: number, log?: (line: string) => void }} options
 */
export async function mapOnArmada({ repo, sha, files, setup, items, command, env = {}, label, pool = items.length, timeout = 3600, log = (line) => console.error(line) }) {
  const armadaDir = armadaClient();
  Object.assign(process.env, armadaEnv());
  const { connect } = await import(join(armadaDir, 'src', 'sdk.ts'));
  const { argvOf, cancelOnInterrupt, onCommit } = await import(join(armadaDir, 'src', 'ci.ts'));
  const { cmd } = await import(join(armadaDir, 'src', 'task.ts'));
  /** @type {OverlayFile[]} */
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
  const ref = `refs/nimbus-armada/${randomUUID()}`;
  git(repo, ['update-ref', ref, commit]);
  // An interrupt exits from the cancel handler, past the finally below.
  const dropRef = () => spawnSync('git', ['update-ref', '-d', ref], { cwd: repo });
  process.once('exit', dropRef);
  try {
    log(`armada: ${sha.slice(0, 12)} as ${commit.slice(0, 12)} (its tree plus ${overlay.map((file) => (typeof file === 'string' ? file : file.path)).join(', ')})`);
    return { commit, ...await runJob({ armada: connect(), client: { argvOf, cancelOnInterrupt, cmd, onCommit }, repo, commit, items, command, env, label, pool, timeout, log }) };
  } finally {
    process.off('exit', dropRef);
    dropRef();
  }
}

/**
 * The job itself, through armada's typed command task: started, followed,
 * cancelled with this process (SIGINT, SIGTERM), and read back. Each
 * outcome keeps the shape callers read ({ index, kind: 'exited' | 'failed',
 * exitCode, seconds, tail }), and each task's {out} is read whatever its
 * exit: a build that exits 1 still hands back its verdict.
 */
async function runJob({ armada, client, repo, commit, items, command, env, label, pool, timeout, log }) {
  // armada resolves the commit in the working directory's repository.
  const cwd = process.cwd();
  process.chdir(repo);
  let where;
  try {
    where = await client.onCommit(armada, commit);
  } finally {
    process.chdir(cwd);
  }
  const task = client.cmd(where.recipe, client.argvOf(command, where.recipe), { output: 'text', timeout });
  const job = task.map(items, { armada, pool, label, env: { ...where.env, ...env }, tmpfs: where.tmpfs });
  const id = await job.id;
  log(`armada: job ${id}`);
  let phase = '';
  const watcher = setInterval(() => {
    job.status().then((status) => {
      if (status.phase === phase) return;
      phase = status.phase;
      log(`armada: ${phase === 'preparing' ? `preparing environment ${status.key.slice(0, 12)} (minutes, once per recipe and lockfile)` : phase}`);
    }, () => {});
  }, 5_000);
  const results = [];
  try {
    await client.cancelOnInterrupt(job, id, async () => {
      for await (const result of job) results.push(result);
    });
  } finally {
    clearInterval(watcher);
  }
  results.sort((a, b) => a.index - b.index);
  const outcomes = results.map((result) => ({
    index: result.index,
    kind: result.kind === 'lost' || result.kind === 'cancelled' ? 'failed' : 'exited',
    exitCode: result.kind === 'timeout' ? 124 : result.meta.exitCode,
    seconds: result.meta.seconds,
    tail: result.kind === 'lost' || result.kind === 'cancelled' ? `${result.reason}\n${result.meta.tail}` : result.meta.tail,
  }));
  const decoder = new TextDecoder();
  const outputs = await Promise.all(results.map(async (result) => {
    const bytes = await job.output(result.index);
    return bytes === null ? null : decoder.decode(bytes);
  }));
  return { jobId: id, outcomes, outputs };
}
