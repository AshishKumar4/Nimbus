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
 * Self-contained but for retrying, a function too: the install facet
 * carries both by source (its preamble, loaders/npm-install-preamble.ts), so
 * a tarball fetch there and a packument fetch in the supervisor (r2-cache.ts)
 * retry alike. The schedule is a literal here, not a module constant: the
 * preamble keeps the identifiers the Worker's bundler gives only functions.
 */
import { retrying } from '@nimbus-sh/platform/retry.js';
/**
 * `fetchOnce(fetch, n)` (try n, 0-based, fetching through `network`) under
 * the registry's retry policy: the last answer, a 5xx included once the
 * re-tries are spent, or the last failure thrown. `onRetry` hears each re-try
 * ("HTTP 503", "timeout", or the error).
 */
export function retryingRegistryFetch(network, fetchOnce, options) {
    return retrying((attempt) => fetchOnce((input, init) => network.fetch(input, init), attempt), {
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
