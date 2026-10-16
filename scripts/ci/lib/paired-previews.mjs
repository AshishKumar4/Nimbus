// The three Previews a run's paired perf probes measure
// (tests/behavioral/_paired.mjs): a1 and a2 of the baseline commit, b of the
// candidate, each a fresh throwaway built on CI and uploaded from here as
// remote-probes --deploy uploads one. An upload reads its app's config from
// a checkout at the release's own commit (uploadConfig), so a commit this
// worktree is not at is uploaded from a detached worktree of it, made for
// this run and removed after it.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ARMS } from '../../../tests/behavioral/_paired.mjs';
import { INSTALL } from '../../install-deps.mjs';
import { NIMBUS_STATE } from './state-dir.mjs';

const git = (cwd, args) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || done.error?.message || '').trim()}`);
  return done.stdout.trim();
};

/** The children `run` started that have not ended, each in a process group of its own, so `halt` can end what they started too. */
const running = new Set();

/** Run `args` in `cwd`; resolves to its stdout, rejects naming the command and its stderr's tail. */
function run(cwd, command, args) {
  return new Promise((resolve, reject) => {
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
 * The arms of one run in `repo`. Everything `standUp` makes is recorded as
 * it is made, so `teardown` (synchronous, for an 'exit' listener as well as
 * the run's end) deletes it whatever ended the run.
 */
export function pairedPreviews({ repo, log = (line) => console.error(line) }) {
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
      const dir = join(NIMBUS_STATE, 'paired', `${runId}-${commit.slice(0, 12)}`);
      mkdirSync(join(NIMBUS_STATE, 'paired'), { recursive: true });
      git(repo, ['worktree', 'add', '--detach', dir, commit]);
      worktrees.push(dir);
      checkouts.set(commit, run(dir, 'bun', INSTALL.split(' ').slice(1)).then(() => dir));
    }
    return checkouts.get(commit);
  };
  const throwaway = (args, arm) => ['tests/behavioral/_throwaway-target.mjs', ...args, '--name', arms[arm].name];
  /** The deployment `arm` serves now, read by this checkout's script (an older baseline's has no `version`). */
  const version = async (arm) => (await run(repo, 'bun', throwaway(['version'], arm))).trim();
  const receipts = {};
  return {
    /**
     * Upload `releases[baseline]` as a1 and a2 and `releases[candidate]` as b.
     * One upload at a time per checkout (they share its .wrangler state), the
     * two checkouts at once; every upload settles before a failure is thrown.
     */
    async standUp({ baseline, candidate, releases }) {
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
          receipts[arm] = await version(arm);
        }
      }));
      for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason;
    },
    /** Each arm's { base, token }, a token minted now to live `ttlMs`. */
    async credentials(ttlMs) {
      return Object.fromEntries(await Promise.all(ARMS.map(async (arm) => [arm,
        JSON.parse(await run(arms[arm].checkout, 'bun', [...throwaway(['token', '--json', '--ttl-ms', String(ttlMs)], arm)]))])));
    },
    /** The deployment each arm served once its upload was ready: what every job must find. */
    receipts() {
      return { ...receipts };
    },
    /** The deployment each arm serves now, by its id. */
    async versions() {
      return Object.fromEntries(await Promise.all(ARMS.map(async (arm) => [arm, await version(arm)])));
    },
    /** End every child still running (an upload, an install) and its own children, and wait for them, at most 30 s. */
    async halt() {
      const ended = [...running].map((child) => new Promise((resolve) => {
        child.once('close', resolve);
        try { process.kill(-child.pid, 'SIGTERM'); } catch { resolve(); }
      }));
      await Promise.race([Promise.all(ended), new Promise((resolve) => setTimeout(resolve, 30_000))]);
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
