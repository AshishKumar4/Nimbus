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
import type { WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
/** What a registry request is fetched through. */
export type RegistryNetwork = Pick<WorkspaceNetwork, 'fetch'>;
/**
 * How far a registry body is read ahead of its reader. Most tarballs are
 * read to their end at once; a batch of eight downloads holds at most 32 MiB
 * so, three (an install shard's) 12 MiB.
 */
export declare const REGISTRY_READ_AHEAD_BYTES: number;
/**
 * `answer`, holding no connection open unread. An invocation with six
 * connections open and none being read, while another waits, has its least
 * recently used closed by the runtime ("Response closed due to connection
 * limit"). So a 2xx's body is read as it arrives, `readAheadBytes` ahead of
 * its reader (one within that is read to its end at once; none, for a caller
 * that reads it whole at once), and any other answer's body is cancelled,
 * keeping only its status, headers and reason, whether or not it could be.
 */
export declare function settleRegistryAnswer(answer: Response, readAheadBytes?: number): Promise<Response>;
/**
 * `fetchOnce(fetch, n)` (try n, 0-based, fetching through `network`, each
 * answer settled as it arrives: settleRegistryAnswer, `readAheadBytes` ahead)
 * under the registry's retry policy: the last answer, a 5xx included once
 * the re-tries are spent, or the last failure thrown. `onRetry` hears each
 * re-try ("HTTP 503", "timeout", or the error).
 */
export declare function retryingRegistryFetch(network: RegistryNetwork, fetchOnce: (fetch: RegistryNetwork['fetch'], attempt: number) => Promise<Response>, options?: {
    retries?: number;
    readAheadBytes?: number;
    onRetry?: (retry: number, of: number, delayMs: number, reason: string) => void;
}): Promise<Response>;
//# sourceMappingURL=registry-retry.d.ts.map