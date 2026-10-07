// One build per checkout at a time (scripts/dist-integrity.mjs: "ONE GATE
// PER CHECKOUT AT A TIME").
//
// The lock is flock(2) on a file in the checkout's git dir, so each worktree
// has its own. It belongs to an open file description of this process: the
// kernel releases it when the process ends, however it ends, and it means
// the same in every PID namespace (run-bounded's bwrap included). So there
// is no owner to check and no stale lock to break. The file is never
// removed, since a waiter would then hold a lock on a removed file while
// another process takes a new one; what it holds only describes the holder,
// for the waiting message.
//
// flock(1) takes the lock on this process's descriptor, passed as its fd 3:
// the lock then belongs to the description both share, and stays with this
// process when flock exits. A lock that ended with this process would free
// the checkout while a build step it started (an orphan, once this process
// is killed) still wrote. So a build step runs in a PID namespace that dies
// with this process (dist-integrity.mjs, stepSandbox), and is handed the
// descriptor as its fd 3 (checkoutLockFd): nothing that can write outlives
// the lock. Nothing else this process starts gets it (Node and Bun open
// files close-on-exec).
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { closeSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { BuildFailure } from './output-transaction.mjs';

/** How long a gate waits for another gate on the same checkout. */
const CHECKOUT_LOCK_WAIT_MS = 30 * 60_000;
/** flock(1)'s exit status when the lock is taken (-n) or the wait ran out (-w). */
const TAKEN = 75;
const lockScope = new AsyncLocalStorage();
/** The lock files this process holds, and the descriptor holding each. */
const heldHere = new Map();

/** The checkout's lock file: in its own git dir, so each worktree has its own. */
export function checkoutLockFile(root) {
  const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' });
  if (gitDir.status !== 0) {
    throw new BuildFailure(`refusing to build — ${root} is not a git checkout, so it has no lock and no rollback: ${(gitDir.stderr || '').trim()}`);
  }
  return join(gitDir.stdout.trim(), 'nimbus-dist-integrity.lock');
}

/** Whether the current task holds `root`'s checkout lock. */
export function holdsCheckoutLock(root) {
  return lockScope.getStore()?.has(checkoutLockFile(root)) ?? false;
}

/**
 * The descriptor holding `root`'s checkout lock, for a build step to
 * inherit (as its fd 3): the lock then outlives this process for as long as
 * the step, or anything the step started, runs. Only within the task that
 * holds the lock.
 */
export function checkoutLockFd(root) {
  const file = checkoutLockFile(root);
  if (!lockScope.getStore()?.has(file)) throw new Error(`checkoutLockFd: this task does not hold the checkout lock on ${root}`);
  return /** @type {number} */ (heldHere.get(file));
}

/**
 * Run `fn` holding `root`'s checkout lock: exclusive across processes, and
 * re-entrant within the task that holds it. Waits up to `waitMs` while
 * another gate holds it. `fn` may be async; the lock is held until it
 * settles.
 *
 * @template T
 * @param {string} root
 * @param {() => T} fn
 * @param {{ log?: (line: string) => void, waitMs?: number }} [options]
 * @returns {T}
 */
export function withCheckoutLock(root, fn, { log = () => {}, waitMs = CHECKOUT_LOCK_WAIT_MS } = {}) {
  const file = checkoutLockFile(root);
  const held = lockScope.getStore();
  if (held?.has(file)) return fn();
  if (heldHere.has(file)) {
    throw new BuildFailure(`refusing to build — this process already holds the checkout lock on ${root} in another task; one gate at a time`);
  }
  const fd = acquire(file, root, log, waitMs);
  heldHere.set(file, fd);
  const release = () => {
    heldHere.delete(file);
    closeSync(fd);
  };
  let result;
  try {
    result = lockScope.run(new Set([...(held ?? []), file]), fn);
  } catch (error) {
    release();
    throw error;
  }
  if (result && typeof (/** @type {any} */ (result)).then === 'function') {
    return /** @type {any} */ (result).finally(release);
  }
  release();
  return result;
}

/** Who holds the lock, as the holder wrote it: a description, never a test of liveness. */
function holder(file) {
  try {
    const { pid, host, since } = JSON.parse(readFileSync(file, 'utf8'));
    return `pid ${pid} on ${host}, since ${since}`;
  } catch {
    return 'it wrote no description';
  }
}

/** Take the lock on a descriptor of `file`, waiting up to `waitMs`; the descriptor holds it. */
function acquire(file, root, log, waitMs) {
  let fd;
  try {
    fd = openSync(file, 'a+');
  } catch (error) {
    throw new BuildFailure(`refusing to build — could not open the checkout lock ${file}: ${error.message}`);
  }
  const flock = (...args) => spawnSync('/usr/bin/flock', ['-x', '-E', String(TAKEN), ...args, '3'], {
    stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8',
  });
  let taken = flock('-n');
  if (taken.status === TAKEN) {
    log(`waiting for the checkout lock: another dist-integrity (${holder(file)}) is building ${root}`);
    taken = flock('-w', String(waitMs / 1000));
    if (taken.status === TAKEN) {
      closeSync(fd);
      throw new BuildFailure(
        `refusing to build — another dist-integrity (${holder(file)}) has held the checkout lock on ${root} `
        + `for longer than ${Math.round(waitMs / 1000)} s. Wait for it to finish: the lock is released when that process ends, however it ends.`,
      );
    }
  }
  if (taken.status !== 0) {
    closeSync(fd);
    throw new BuildFailure(`refusing to build — could not take the checkout lock ${file}: ${taken.error?.message ?? (taken.stderr.trim() || `flock exited ${taken.status}`)}`);
  }
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), root, since: new Date().toISOString() }));
  } catch (error) {
    // Closed, the descriptor releases the lock it just took.
    closeSync(fd);
    throw new BuildFailure(`refusing to build — could not describe the holder in the checkout lock ${file}: ${error.message}`);
  }
  return fd;
}
