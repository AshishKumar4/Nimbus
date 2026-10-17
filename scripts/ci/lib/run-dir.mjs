// A CI run's own files: what it makes for itself and nothing after it reads,
// such as the baseline checkouts its paired arms upload from and the releases
// it uploads to throwaways. They sit in one directory per run, beside the
// checkout that runs it and so on that checkout's disk, and the run deletes
// it when it ends.
//
// A run that is killed cannot delete anything, so the run holds a lock
// (scripts/lib/flock.mjs) beside its directory while it lives, and the kernel
// lets go of it however the run ends. Each new run first deletes every
// directory whose lock it can take: a run that no longer exists left it.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FlockError, holdFlock } from '../../lib/flock.mjs';

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/** Where `repo`'s runs keep their files: beside it. */
export const runsRoot = (repo) => join(dirname(repo), '.nimbus-runs');

/** Delete `dir` and every git worktree in it; returns what could not be, each with why. */
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

/** Delete what each run under `root` that no longer holds its lock left there. */
function sweep(repo, root, log) {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.lock')) continue;
    const lock = join(root, name);
    let fd;
    try {
      fd = holdFlock(lock, { waitMs: 0 });
    } catch (error) {
      if (error instanceof FlockError && error.kind === 'timeout') continue;
      throw error;
    }
    const dir = lock.slice(0, -'.lock'.length);
    for (const line of removeDir(repo, dir)) log(`run files: LEFT BEHIND ${line}`);
    unlinkSync(lock);
    closeSync(fd);
  }
}

/**
 * Open this run's directory for `repo`, after deleting what killed runs
 * left. `close` (synchronous, so an 'exit' listener can call it) deletes it
 * and returns what could not be deleted. `keep` leaves it, for whoever
 * finishes what the run could not, and no sweep deletes it.
 *
 * @param {string} repo
 * @param {(line: string) => void} [log]
 */
export function openRunDir(repo, log = (line) => console.error(line)) {
  const root = runsRoot(repo);
  sweep(repo, root, log);
  const dir = join(root, `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`);
  // Locked under a name no sweep takes, then renamed: a sweep never finds this lock before it is held.
  const fd = holdFlock(`${dir}.locking`, { waitMs: 0, describe: { repo } });
  renameSync(`${dir}.locking`, `${dir}.lock`);
  mkdirSync(dir);
  let left = null;
  return {
    dir,
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
