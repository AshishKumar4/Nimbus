// A CI run's own files: what it makes for itself and nothing after it reads,
// such as the baseline checkouts its paired arms upload from and the releases
// it uploads to throwaways. They sit in one directory per run under RUNS
// (state-dir.mjs), and the run deletes it when it ends.
//
// A run that is killed cannot delete anything, so the run holds a lock
// (scripts/lib/flock.mjs) beside its directory while it lives, and hands it
// to every process it starts that uses the directory: the kernel lets go of
// it once the last of them ends, however they end. Each new run first deletes
// every directory whose lock it can take.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { holdFlock, tryFlock } from '../../lib/flock.mjs';
import { RUNS } from './state-dir.mjs';

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/** Delete `dir` and every git worktree of `repo` in it; returns what could not be, each with why. */
function removeDir(repo, dir) {
  const left = [];
  const listed = git(repo, ['worktree', 'list', '--porcelain']);
  for (const line of listed.stdout.split('\n')) {
    const path = line.startsWith('worktree ') ? line.slice('worktree '.length) : null;
    if (path === null || !path.startsWith(`${dir}/`)) continue;
    const removed = git(repo, ['worktree', 'remove', '--force', path]);
    if (removed.status !== 0) left.push(`worktree ${path}: ${removed.stderr.trim()}`);
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    left.push(`${dir}: ${error.message}`);
  }
  git(repo, ['worktree', 'prune']);
  return left;
}

/**
 * Delete what each run under `root` that no longer holds its lock left there.
 * A lock is opened, never made: one its run has just deleted or kept is
 * skipped, and so is a descriptor whose file was renamed or deleted between
 * the listing and the lock (a run closing or keeping, another sweep).
 */
function sweep(repo, root, log) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    const lock = join(root, name);
    let fd;
    try {
      fd = openSync(lock, 'r+');
    } catch {
      continue;
    }
    try {
      if (!tryFlock(fd) || statSync(lock, { throwIfNoEntry: false })?.ino !== fstatSync(fd).ino) continue;
      for (const line of removeDir(repo, lock.slice(0, -'.lock'.length))) log(`run files: LEFT BEHIND ${line}`);
      unlinkSync(lock);
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * Open this run's directory, after deleting what dead runs left. `stdio`
 * hands its lock to a process the run starts, as its fd 3, so the directory
 * outlives the run for as long as that process uses it. `close`
 * (synchronous, so an 'exit' listener can call it) deletes the directory and
 * returns what could not be deleted; `keep` leaves it, and no sweep deletes
 * it, for whoever finishes what the run could not.
 *
 * @param {string} repo the checkout whose worktrees the run makes in its directory
 * @param {(line: string) => void} [log]
 */
export function openRunDir(repo, log = (line) => console.error(line)) {
  sweep(repo, RUNS, log);
  const dir = join(RUNS, `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`);
  // Locked under a name no sweep opens, then renamed: a sweep never finds this lock before it is held.
  const fd = holdFlock(`${dir}.locking`, { waitMs: 0, describe: { repo } });
  renameSync(`${dir}.locking`, `${dir}.lock`);
  mkdirSync(dir);
  let left = null;
  return {
    dir,
    /** @param {Array<'ignore' | 'pipe' | 'inherit'>} stdio */
    stdio: (stdio) => [...stdio, fd],
    close() {
      if (left) return left;
      left = removeDir(repo, dir);
      try {
        unlinkSync(`${dir}.lock`);
      } catch (error) {
        left.push(`${dir}.lock: ${error.message}`);
      }
      closeSync(fd);
      return left;
    },
    keep() {
      if (left) return left;
      renameSync(`${dir}.lock`, `${dir}.kept`);
      closeSync(fd);
      left = [`${dir}: kept; delete it, and ${dir}.kept, once the lines above are finished`];
      return left;
    },
  };
}
