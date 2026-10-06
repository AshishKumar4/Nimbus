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
 * Self-contained but for retrying, a function too: the install facet
 * carries both by source (its preamble, loaders/npm-install-preamble.ts), so
 * a tarball fetch there and a packument fetch in the supervisor (r2-cache.ts)
 * retry alike. The schedule is a literal here, not a module constant: the
 * preamble keeps the identifiers the Worker's bundler gives only functions.
 */
/**
 * `fetchOnce(n)` (try n, 0-based) under the registry's retry policy: the last
 * answer, a 5xx included once the re-tries are spent, or the last failure
 * thrown. `onRetry` hears each re-try ("HTTP 503", "timeout", or the error).
 */
export declare function retryingRegistryFetch(fetchOnce: (attempt: number) => Promise<Response>, options?: {
    retries?: number;
    onRetry?: (retry: number, of: number, delayMs: number, reason: string) => void;
}): Promise<Response>;
//# sourceMappingURL=registry-retry.d.ts.map