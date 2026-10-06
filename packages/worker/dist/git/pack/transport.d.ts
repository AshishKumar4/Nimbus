/**
 * git/pack/transport.ts — the one policy for a lost transport, wherever the
 * git layer crosses one: what counts as lost, how many times a request that
 * crossed it is tried, and how far apart.
 *
 * - An HTTP request to the git server: upload-pack.ts's for a clone, and
 *   cf-git's (retryingGitHttp) for fetch, pull and push. Retried when it
 *   failed before an answer, answered with a transient edge status, or sent
 *   no headers within STALL_MS; only an idempotent one (a GET, an
 *   upload-pack POST: it changes nothing on the server).
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
 * Each is tried RETRY_ATTEMPTS times, RETRY_BACKOFF_MS apart (each wait
 * jittered by a quarter); every retry is logged by its caller with its
 * cause. Nothing else is retried.
 */
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
/** Whether a failure's message names a lost transport to the git server (a hang is known by its timeout). */
export declare function isLostTransport(message: string): boolean;
/** The wait before try `attempt + 2` (0-based `attempt` of the one that failed). */
export declare function retryDelay(attempt: number, schedule?: readonly number[]): Promise<void>;
/** cf-git's HTTP client surface (isomorphic-git's GitHttp). */
export interface GitHttpRequest {
    url: unknown;
    method?: string;
    body?: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | null;
    [key: string]: unknown;
}
export interface GitHttpResponse {
    statusCode: number;
    body?: {
        cancel?: () => unknown;
    } | null;
    [key: string]: unknown;
}
export interface GitHttp {
    request(req: GitHttpRequest): Promise<GitHttpResponse>;
}
/**
 * cf-git's HTTP client under this policy: an idempotent request (a GET, an
 * upload-pack POST, whose body is kept to be sent again) that fails before
 * its answer, or is answered with a transient status, is tried again.
 * `schedule` is for tests.
 */
export declare function retryingGitHttp(base: GitHttp, schedule?: readonly number[]): GitHttp;
//# sourceMappingURL=transport.d.ts.map