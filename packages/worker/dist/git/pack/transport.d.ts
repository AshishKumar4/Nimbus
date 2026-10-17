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
import { type RemoteFailure } from './remote-failure.js';
export interface GitTransportAuth {
    username: string;
    password: string;
}
/** URL normalization and credential selection shared by upload-pack and receive-pack. */
export declare function gitHttpRemote(options: {
    url: string;
    auth?: GitTransportAuth;
}): {
    url: string;
    auth: GitTransportAuth;
};
export declare function gitHttpHeaders(auth: GitTransportAuth | undefined, extra: Record<string, string>): Record<string, string>;
export declare const RETRY_ATTEMPTS = 3;
/** The waits before the second and the third try. */
export declare const RETRY_BACKOFF_MS: readonly number[];
/** Statuses a git host's edge answers while the request may go through on another try. */
export declare const TRANSIENT_HTTP_STATUSES: ReadonlySet<number>;
/**
 * A response that sends nothing for this long has stalled: git's own
 * http.lowSpeedTime is the same idea. Measured: a GitHub batch on react
 * hung 240 s with no bytes; a healthy one never pauses for more than a few.
 */
export declare const STALL_MS = 45000;
/** What upload-pack.ts throws for a request to the git server that failed in transit. */
export declare const UPLOAD_PACK_ERROR_PREFIX = "git upload-pack: ";
/**
 * The agent capability a request asks with: only of a server that
 * advertised its own, as fetch-pack.c and send-pack.c send it
 * (gitprotocol-capabilities "agent"); a server that did not may refuse it.
 */
export declare function agentCapability(advertised: ReadonlySet<string>): string[];
/** Whether a failure's message names a lost transport to the git server (a hang is known by its timeout). */
export declare function isLostTransport(message: string): boolean;
/** The wait before try `attempt + 2` (0-based `attempt` of the one that failed). */
export declare function retryDelay(attempt: number, schedule?: readonly number[]): Promise<void>;
export declare class UploadPackError extends Error {
    readonly status?: number | undefined;
    readonly failure?: RemoteFailure | undefined;
    constructor(message: string, status?: number | undefined, failure?: RemoteFailure | undefined);
}
//# sourceMappingURL=transport.d.ts.map