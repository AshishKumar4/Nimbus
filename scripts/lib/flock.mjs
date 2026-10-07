// An exclusive flock(2) on a file, held by an open file description of this
// process: the kernel releases it when the process ends, however it ends,
// and it means the same in every PID namespace. So there is no owner to
// check and no stale lock to break. The file is never removed (a waiter
// would then hold a lock on a removed file while another process takes a
// new one); what it holds only describes the holder, for whoever waits.
//
// flock(1) takes the lock on this process's descriptor, passed as its fd 3:
// the lock belongs to the description both share, and stays with this
// process when flock exits. Node and Bun open files close-on-exec, so a
// child gets the descriptor, and the lock, only when it is handed over.
//
// Used by the checkout lock (scripts/lib/checkout-lock.mjs) and the shared
// environments' leases (scripts/ci/lib/lease.mjs).
import { spawnSync } from 'node:child_process';
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

/** flock(1)'s exit status when the lock is taken (-n) or the wait ran out (-w). */
const TAKEN = 75;

/** Why a lock was not taken: `kind` is open, timeout, flock or describe; `holder` describes who has it. */
export class FlockError extends Error {
  /** @param {'open' | 'timeout' | 'flock' | 'describe'} kind @param {string} message @param {string} [holder] */
  constructor(kind, message, holder = '') {
    super(message);
    this.name = 'FlockError';
    this.kind = kind;
    this.holder = holder;
  }
}

/** Who holds the lock on `file`, as the holder wrote it: a description, never a test of liveness. */
export function flockHolder(file) {
  try {
    const { pid, host, since, ...rest } = JSON.parse(readFileSync(file, 'utf8'));
    const extra = Object.entries(rest).filter(([key]) => key !== 'root').map(([key, value]) => `${key} ${value}`).join(', ');
    return `pid ${pid} on ${host}, since ${since}${extra ? `, ${extra}` : ''}`;
  } catch {
    return 'it wrote no description';
  }
}

/**
 * Take the exclusive lock on `file` (created, with its directory, when
 * absent), waiting up to `waitMs` while another holds it (`onWait` is told
 * who, once). Writes `describe` (with pid, host and since) into the file for
 * the next waiter. Returns the descriptor holding the lock: closing it, or
 * this process ending, releases it. Throws FlockError.
 *
 * @param {string} file
 * @param {{ waitMs: number, describe?: Record<string, unknown>, onWait?: (holder: string) => void }} options
 */
export function holdFlock(file, { waitMs, describe = {}, onWait = () => {} }) {
  let fd;
  try {
    mkdirSync(dirname(file), { recursive: true });
    fd = openSync(file, 'a+');
  } catch (error) {
    throw new FlockError('open', `could not open the lock ${file}: ${error.message}`);
  }
  const flock = (...args) => spawnSync('/usr/bin/flock', ['-x', '-E', String(TAKEN), ...args, '3'], {
    stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8',
  });
  let taken = flock('-n');
  if (taken.status === TAKEN) {
    onWait(flockHolder(file));
    taken = flock('-w', String(waitMs / 1000));
    if (taken.status === TAKEN) {
      const holder = flockHolder(file);
      closeSync(fd);
      throw new FlockError('timeout', `${holder} has held ${file} for longer than ${Math.round(waitMs / 1000)} s`, holder);
    }
  }
  if (taken.status !== 0) {
    closeSync(fd);
    throw new FlockError('flock', `could not take the lock ${file}: ${taken.error?.message ?? (taken.stderr.trim() || `flock exited ${taken.status}`)}`);
  }
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString(), ...describe }));
  } catch (error) {
    // Closed, the descriptor releases the lock it just took.
    closeSync(fd);
    throw new FlockError('describe', `could not describe the holder in the lock ${file}: ${error.message}`);
  }
  return fd;
}
