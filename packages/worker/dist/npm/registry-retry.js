/**
 * registry-retry.ts — what npm's requests to its registry try again
 * (@nimbus-sh/platform retry.ts is the loop): a 5xx answer or a request that
 * never answered, three more times, 500/1500/4500 ms apart (±25%). A 4xx is
 * an answer (404: no such package or version) and is never retried.
 *
 * Worst case, a degraded registry adds about 6.5 s to a request; npm's own
 * client waits far longer, but here an install's iteration speed matters
 * more than its last-ditch resilience.
 *
 * Every try goes through the network it is given, never the isolate's
 * fetch: the supervisor's packument fetch passes the workspace's network
 * (core _shared/workspace-network.ts, which an egress may own), the install
 * facet its own fetch, which its loader already routes there.
 *
 * The install facet's build-time compilation carries this function and
 * retrying together, so a tarball fetch there and a packument fetch in the
 * supervisor (r2-cache.ts) use the same policy.
 */
import { retrying } from '@nimbus-sh/platform/retry.js';
/**
 * How far a registry body is read ahead of its reader. Most tarballs are
 * read to their end at once; a batch of eight downloads holds at most 32 MiB
 * so, three (an install shard's) 12 MiB.
 */
export const REGISTRY_READ_AHEAD_BYTES = 4 * 1024 * 1024;
/**
 * `answer`, holding no connection open unread. An invocation with six
 * connections open and none being read, while another waits, has its least
 * recently used closed by the runtime ("Response closed due to connection
 * limit"). So a 2xx's body is read as it arrives, `readAheadBytes` ahead of
 * its reader (one within that is read to its end at once; none, for a caller
 * that reads it whole at once), and any other answer's body is cancelled,
 * keeping only its status, headers and reason, whether or not it could be.
 */
export async function settleRegistryAnswer(answer, readAheadBytes = REGISTRY_READ_AHEAD_BYTES) {
    const init = { status: answer.status, statusText: answer.statusText, headers: answer.headers };
    if (!answer.ok || answer.body === null) {
        await answer.body?.cancel().catch(() => { });
        return new Response(null, init);
    }
    if (readAheadBytes === 0)
        return answer;
    const reader = answer.body.getReader();
    const queue = [];
    let queued = 0;
    let ended = false;
    let failure = null;
    // Who waits: the reader for a chunk, the read for room.
    const waiting = { chunk: null, room: null };
    void (async () => {
        try {
            for (;;) {
                while (queued >= readAheadBytes)
                    await new Promise((resolve) => { waiting.room = resolve; });
                const { value, done } = await reader.read();
                if (done)
                    break;
                queue.push(value);
                queued += value.byteLength;
                waiting.chunk?.();
            }
        }
        catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
        }
        ended = true;
        waiting.chunk?.();
    })();
    const body = new ReadableStream({
        async pull(controller) {
            while (queue.length === 0 && !ended)
                await new Promise((resolve) => { waiting.chunk = resolve; });
            const chunk = queue.shift();
            if (chunk !== undefined) {
                queued -= chunk.byteLength;
                waiting.room?.();
                controller.enqueue(chunk);
            }
            else if (failure !== null) {
                controller.error(failure);
            }
            else {
                controller.close();
            }
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
    return new Response(body, init);
}
/**
 * `fetchOnce(fetch, n)` (try n, 0-based, fetching through `network`, each
 * answer settled as it arrives: settleRegistryAnswer, `readAheadBytes` ahead)
 * under the registry's retry policy: the last answer, a 5xx included once
 * the re-tries are spent, or the last failure thrown. `onRetry` hears each
 * re-try ("HTTP 503", "timeout", or the error).
 */
export function retryingRegistryFetch(network, fetchOnce, options) {
    const readAheadBytes = options?.readAheadBytes ?? REGISTRY_READ_AHEAD_BYTES;
    return retrying((attempt) => fetchOnce(async (input, init) => settleRegistryAnswer(await network.fetch(input, init), readAheadBytes), attempt), {
        retries: Math.max(0, options?.retries ?? 3),
        // The waits before each re-try.
        schedule: [500, 1500, 4500],
        retryReason: (outcome) => {
            if (outcome.ok)
                return outcome.value.status >= 500 && outcome.value.status <= 599 ? 'HTTP ' + outcome.value.status : null;
            const error = outcome.error;
            if (error instanceof Error)
                return error.name === 'AbortError' ? 'timeout' : error.message;
            return String(error);
        },
        discard: (response) => response.body?.cancel(),
        onRetry: options?.onRetry,
    });
}
