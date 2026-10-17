// The three Previews a run's paired perf probes measure
// (tests/behavioral/_paired.mjs): a1 and a2 of the baseline commit, b of the
// candidate, each a fresh throwaway built on CI and uploaded from here as
// remote-probes --deploy uploads one. An upload reads its app's config from
// a checkout at the release's own commit (uploadConfig), so a commit this
// worktree is not at is uploaded from a detached worktree of it, made in the
// run's own directory (lib/run-dir.mjs) and removed with it.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ARMS } from '../../../tests/behavioral/_paired.mjs';
import { INSTALL } from '../../install-deps.mjs';

const git = (cwd, args) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || done.error?.message || '').trim()}`);
  return done.stdout.trim();
};

/** The children `run` started that have not ended, each in a process group of its own, so `halt` can end what they started too. */
const running = new Set();
/** Set by `halt`: from then on `run` starts nothing. */
let halted = false;

/** Run `args` in `cwd`; resolves to its stdout, rejects naming the command and its stderr's tail. */
function run(cwd, command, args) {
  return new Promise((resolve, reject) => {
    if (halted) {
      reject(new Error(`halted before ${command} ${args.slice(0, 3).join(' ')} could start`));
      return;
    }
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    running.add(child);
    child.on('close', () => running.delete(child));
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text) => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout)
      : reject(new Error(`${command} ${args.slice(0, 3).join(' ')} exited ${code} in ${cwd}:\n${stderr.trimEnd().split('\n').slice(-15).join('\n')}`))));
  });
}

/** The commit a candidate is measured against by default: where it leaves origin/main. */
export function defaultBaseline(repo, sha) {
  return git(repo, ['merge-base', sha, 'origin/main']);
}

/**
 * The arms of one run in `repo`, its checkouts made in `dir` (the run's
 * own). Everything `standUp` makes is recorded as it is made, so `teardown`
 * (synchronous, for an 'exit' listener as well as the run's end) deletes it
 * whatever ended the run.
 */
export function pairedPreviews({ repo, dir, log = (line) => console.error(line) }) {
  const runId = randomBytes(3).toString('hex');
  const worktrees = [];
  const previews = [];
  const arms = {};
  let left = null;
  /** A clean checkout at `commit`: this one when it is there, else a detached worktree with dependencies installed. */
  const checkouts = new Map();
  const checkoutAt = (commit) => {
    if (git(repo, ['rev-parse', 'HEAD']) === commit) return Promise.resolve(repo);
    if (!checkouts.has(commit)) {
      const checkout = join(dir, `checkout-${commit.slice(0, 12)}`);
      git(repo, ['worktree', 'add', '--detach', checkout, commit]);
      worktrees.push(checkout);
      checkouts.set(commit, run(checkout, 'bun', INSTALL.split(' ').slice(1)).then(() => checkout));
    }
    return checkouts.get(commit);
  };
  const throwaway = (args, arm) => ['tests/behavioral/_throwaway-target.mjs', ...args, '--name', arms[arm].name];
  /** The deployment `arm` serves now, read by this checkout's script (an older baseline's has no `version`). */
  const version = async (arm) => (await run(repo, 'bun', throwaway(['version'], arm))).trim();
  const receipts = {};
  /** The stand-up while it runs, so `halt` waits for it to unwind. */
  let standing = Promise.resolve();
  /** Upload each arm; see standUp. */
  const upload = async ({ baseline, candidate, releases }) => {
    // Imported once remote-probes has checked the install: the record path lives beside the deploy code.
    const { readState, throwawayStatePath } = await import('../../../tests/behavioral/_deploy-target.mjs');
    const commit = { a1: baseline, a2: baseline, b: candidate };
    const groups = new Map();
    for (const arm of ARMS) {
      const checkout = await checkoutAt(commit[arm]);
      arms[arm] = { name: `pp-${runId}-${arm}`, checkout };
      groups.set(checkout, [...(groups.get(checkout) ?? []), arm]);
    }
    const settled = await Promise.allSettled([...groups.values()].map(async (group) => {
      for (const arm of group) {
        previews.push(arms[arm]);
        log(`paired: ${arm} is ${commit[arm].slice(0, 12)} on throwaway ${arms[arm].name}`);
        await run(arms[arm].checkout, 'bun', [...throwaway(['up', '--bundle', releases[commit[arm]]], arm)]);
        receipts[arm] = readState(throwawayStatePath(arms[arm].checkout, arms[arm].name))?.versionId;
        if (!receipts[arm]) throw new Error(`${arms[arm].name}'s upload recorded no deployment in ${arms[arm].checkout}`);
      }
    }));
    for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason;
  };

  return {
    /**
     * Upload `releases[baseline]` as a1 and a2 and `releases[candidate]` as b.
     * One upload at a time per checkout (they share its .wrangler state), the
     * two checkouts at once; every upload settles before a failure is thrown.
     */
    standUp(options) {
      standing = upload(options);
      return standing;
    },
    /** Each arm's { base, token }, a token minted now to live `ttlMs`. */
    async credentials(ttlMs) {
      return Object.fromEntries(await Promise.all(ARMS.map(async (arm) => [arm,
        JSON.parse(await run(arms[arm].checkout, 'bun', [...throwaway(['token', '--json', '--ttl-ms', String(ttlMs)], arm)]))])));
    },
    /** The deployment each arm's upload made (its record's versionId): what every job must find. */
    receipts() {
      return { ...receipts };
    },
    /** The deployment each arm serves now, by its id. */
    async versions() {
      return Object.fromEntries(await Promise.all(ARMS.map(async (arm) => [arm, await version(arm)])));
    },
    /**
     * Start nothing more, end every child still running (an upload, an
     * install) and its own children (SIGTERM, then after 30 s SIGKILL), and
     * wait for them and for the stand-up to unwind, so teardown never
     * deletes what a writer is still making.
     */
    async halt() {
      halted = true;
      const signal = (kill) => {
        for (const child of running) {
          try { process.kill(-child.pid, kill); } catch { /* its group has already ended */ }
        }
      };
      const ended = Promise.all([...running].map((child) => new Promise((resolve) => child.once('close', resolve))));
      signal('SIGTERM');
      const grace = setTimeout(() => signal('SIGKILL'), 30_000);
      await Promise.allSettled([ended, standing]);
      clearTimeout(grace);
    },
    /** Delete every Preview and worktree made here, once; returns what could not be, each with the command that finishes it. */
    teardown() {
      if (left) return left;
      left = [];
      for (const { name, checkout } of previews) {
        const down = spawnSync('bun', ['tests/behavioral/_throwaway-target.mjs', 'down', '--name', name], { cwd: checkout, encoding: 'utf8' });
        if (down.status !== 0) left.push(`Preview ${name}: finish with (cd ${checkout} && bun tests/behavioral/_throwaway-target.mjs down --name ${name})`);
      }
      for (const dir of worktrees) {
        if (left.some((line) => line.includes(dir))) continue;
        try { git(repo, ['worktree', 'remove', '--force', dir]); } catch (error) { left.push(`worktree ${dir}: ${error.message}`); }
      }
      return left;
    },
  };
}
