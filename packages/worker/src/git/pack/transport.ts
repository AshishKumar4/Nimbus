/**
 * git/pack/transport.ts — the one policy for a lost transport, wherever the
 * git layer crosses one: what counts as lost, how many times a request that
 * crossed it is tried, and how far apart.
 *
 * - An HTTP request to the git server: upload-pack.ts's for a clone, a
 *   fetch and a pull, receive-pack.ts's for a push. Retried when it failed
 *   before an answer, answered with a transient edge status, or sent no
 *   headers within STALL_MS; only an idempotent one (a GET, an upload-pack
 *   POST: it changes nothing on the server).
 * - A clone piece (network-facet.ts invokeClonePhase): its request failed
 *   in transit (an UploadPackError), or it hung. Objects are addressed by
 *   content, so a piece run again writes what it would have; a hung one
 *   loses its write authority first (CloneFacets.fence).
 *
 * The hop to the session is the platform's: a write wave whose answer is
 * lost ("Network connection lost") is re-sent by the wave writer
 * (@nimbus-sh/platform/wave-writer.js), a ranged write by SupervisorRPC's
 * delivery, each under its own receipt; a piece never repeats them.
 *
 * Each is tried RETRY_ATTEMPTS times, RETRY_BACKOFF_MS apart, through the
 * platform's one retry policy (@nimbus-sh/platform retry.ts: its loop, and
 * each wait jittered by a quarter); every retry is logged by its caller
 * with its cause. Nothing else is retried.
 */

import { retryDelayMs } from '@nimbus-sh/platform/retry.js';
import { base64Utf8 } from '@nimbus-sh/core/_shared/crypto.js';
import { selectRemoteCredentials, type RemoteFailure } from './remote-failure.js';

export interface GitTransportAuth { username: string; password: string }

/** URL normalization and credential selection shared by upload-pack and receive-pack. */
export function gitHttpRemote(options: { url: string; auth?: GitTransportAuth }): { url: string; auth: GitTransportAuth } {
  const auth = selectRemoteCredentials(options.url, options.auth);
  const parsed = URL.canParse(options.url) ? new URL(options.url) : null;
  let url = options.url;
  if (parsed && (parsed.username !== '' || parsed.password !== '')) {
    parsed.username = ''; parsed.password = ''; url = parsed.href;
  }
  return { url: url.endsWith('/') ? url.slice(0, -1) : url, auth };
}

export function gitHttpHeaders(auth: GitTransportAuth | undefined, extra: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = { 'user-agent': 'git/nimbus', ...extra };
  if (auth && (auth.username || auth.password)) result.authorization = 'Basic ' + base64Utf8(auth.username + ':' + auth.password);
  return result;
}


export const RETRY_ATTEMPTS = 3;
/** The waits before the second and the third try. */
export const RETRY_BACKOFF_MS: readonly number[] = [1_000, 3_000];
/** Statuses a git host's edge answers while the request may go through on another try. */
export const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 503, 504, 522, 523, 524, 525]);
/**
 * A response that sends nothing for this long has stalled: git's own
 * http.lowSpeedTime is the same idea. Measured: a GitHub batch on react
 * hung 240 s with no bytes; a healthy one never pauses for more than a few.
 */
export const STALL_MS = 45_000;

/** What upload-pack.ts throws for a request to the git server that failed in transit. */
export const UPLOAD_PACK_ERROR_PREFIX = 'git upload-pack: ';

/** Whether a failure's message names a lost transport to the git server (a hang is known by its timeout). */
export function isLostTransport(message: string): boolean {
  return message.startsWith(UPLOAD_PACK_ERROR_PREFIX);
}

/** The wait before try `attempt + 2` (0-based `attempt` of the one that failed). */
export function retryDelay(attempt: number, schedule: readonly number[] = RETRY_BACKOFF_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, retryDelayMs(schedule, attempt)));
}

export class UploadPackError extends Error {
  constructor(message: string, readonly status?: number, readonly failure?: RemoteFailure) {
    super(UPLOAD_PACK_ERROR_PREFIX + message);
    this.name = 'UploadPackError';
  }
}
