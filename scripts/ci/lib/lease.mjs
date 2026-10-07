// One verified deploy at a time per shared environment (staging,
// production), across every lane: an exclusive flock(2)
// (scripts/lib/flock.mjs) on ~/.local/state/nimbus/leases/<environment>.lock,
// held from the upload through the checks that grade it, so no other lane's
// upload lands while one lane's matrix decides about its own. Every lane
// runs on this machine as this user, so this machine's state directory is
// one every lane sees; a deploy from elsewhere is not excluded by it, which
// is what the version-id brackets (release.mjs, promote.mjs) catch.
//
// The lease is this process's: the kernel releases it when the process
// ends, however it ends. Every entry point that writes a leased environment
// takes it (release.mjs, promote.mjs, _staging-target.mjs up), and hands
// the descriptor to each writer it starts (wrangler) as fd 3, so a writer
// left running by a killed driver still holds it. A child handed the lease
// as fd 3 holds it already: holdLease sees that and takes it from there,
// rather than waiting on itself.
//
// The lease is local to this machine. A deploy from a credentialed host
// elsewhere is not excluded by it; the API's version ids, read before and
// after each graded run (release.mjs, promote.mjs), are what catch that.
import { spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FlockError, holdFlock } from '../../lib/flock.mjs';

export const LEASES = join(homedir(), '.local', 'state', 'nimbus', 'leases');

/** The descriptor a writer is handed a lease on. */
const INHERITED_FD = 3;

/**
 * Whether this process was handed `file`'s lease: its fd 3 is that file,
 * and an exclusive flock on it succeeds at once, which it does only on the
 * open file description that already holds it.
 */
function inherited(file) {
  try {
    if (readlinkSync(`/proc/self/fd/${INHERITED_FD}`) !== file) return false;
  } catch {
    return false;
  }
  const held = spawnSync('/usr/bin/flock', ['-x', '-n', String(INHERITED_FD)], { stdio: ['ignore', 'ignore', 'ignore', INHERITED_FD] });
  return held.status === 0;
}

/** How long a lane waits for another's deploy and matrix on the same environment. */
const LEASE_WAIT_MS = 90 * 60_000;

/**
 * Hold `environment`'s lease for the rest of this process, waiting up to
 * `waitMs` for the lane holding it. `what` describes this holder (commit,
 * worktree) for the next waiter. Returns the descriptor holding it; throws,
 * naming the holder, when the wait runs out.
 *
 * @param {string} environment
 * @param {{ what: Record<string, unknown>, log?: (line: string) => void, waitMs?: number, dir?: string }} options
 */
export function holdLease(environment, { what, log = (line) => console.error(line), waitMs = LEASE_WAIT_MS, dir = LEASES }) {
  const file = join(dir, `${environment}.lock`);
  if (inherited(file)) {
    log(`lease: holding ${environment}, handed down by the run that took it`);
    return INHERITED_FD;
  }
  try {
    const fd = holdFlock(file, {
      waitMs,
      describe: { environment, ...what },
      onWait: (holder) => log(`lease: waiting for ${environment}: ${holder} is deploying and verifying it`),
    });
    log(`lease: holding ${environment} until this run ends`);
    return fd;
  } catch (error) {
    if (!(error instanceof FlockError)) throw error;
    throw new Error(error.kind === 'timeout'
      ? `${environment} has been held for longer than ${Math.round(waitMs / 60_000)} min by ${error.holder}; it is released when that process ends`
      : `could not take the ${environment} lease: ${error.message}`);
  }
}
