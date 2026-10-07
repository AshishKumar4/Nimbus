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
// ends, however it ends. release.mjs hands the descriptor holdLease returns
// to its upload child as fd 3, so an upload left running by a killed
// driver still holds it.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FlockError, holdFlock } from '../../lib/flock.mjs';

export const LEASES = join(homedir(), '.local', 'state', 'nimbus', 'leases');

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
  try {
    const fd = holdFlock(join(dir, `${environment}.lock`), {
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
