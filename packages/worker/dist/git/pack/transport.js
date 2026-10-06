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
export const RETRY_ATTEMPTS = 3;
/** The waits before the second and the third try. */
export const RETRY_BACKOFF_MS = [1_000, 3_000];
/** Statuses a git host's edge answers while the request may go through on another try. */
export const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504, 522, 523, 524, 525]);
/**
 * A response that sends nothing for this long has stalled: git's own
 * http.lowSpeedTime is the same idea. Measured: a GitHub batch on react
 * hung 240 s with no bytes; a healthy one never pauses for more than a few.
 */
export const STALL_MS = 45_000;
/** What upload-pack.ts throws for a request to the git server that failed in transit. */
export const UPLOAD_PACK_ERROR_PREFIX = 'git upload-pack: ';
/** Whether a failure's message names a lost transport to the git server (a hang is known by its timeout). */
export function isLostTransport(message) {
    return message.startsWith(UPLOAD_PACK_ERROR_PREFIX);
}
/** The wait before try `attempt + 2` (0-based `attempt` of the one that failed). */
export function retryDelay(attempt, schedule = RETRY_BACKOFF_MS) {
    const base = schedule[Math.min(attempt, schedule.length - 1)] ?? 0;
    const delay = Math.max(0, Math.round(base + (Math.random() * 2 - 1) * base * 0.25));
    return new Promise((resolve) => setTimeout(resolve, delay));
}
/**
 * cf-git's HTTP client under this policy: an idempotent request (a GET, an
 * upload-pack POST, whose body is kept to be sent again) that fails before
 * its answer, or is answered with a transient status, is tried again.
 * `schedule` is for tests.
 */
export function retryingGitHttp(base, schedule = RETRY_BACKOFF_MS) {
    return {
        async request(req) {
            const method = req.method ?? 'GET';
            const idempotent = method === 'GET' || String(req.url).includes('git-upload-pack');
            let request = req;
            if (idempotent && method !== 'GET' && req.body) {
                const chunks = [];
                for await (const chunk of req.body)
                    chunks.push(chunk);
                request = { ...req, body: chunks };
            }
            for (let attempt = 0;; attempt++) {
                const last = attempt + 1 >= RETRY_ATTEMPTS;
                let response;
                try {
                    response = await base.request(request);
                }
                catch (error) {
                    if (!idempotent || last)
                        throw error;
                    await retryDelay(attempt, schedule);
                    continue;
                }
                if (!idempotent || !TRANSIENT_HTTP_STATUSES.has(response.statusCode) || last)
                    return response;
                try {
                    await response.body?.cancel?.();
                }
                catch {
                    // The answer is being dropped either way.
                }
                await retryDelay(attempt, schedule);
            }
        },
    };
}
