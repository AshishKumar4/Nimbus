/**
 * retry.ts — small, dependency-free retry helper for flaky HTTP GETs.
 *
 * The npm path (resolver packument fetches + tarball fetches) talks to
 * registry.npmjs.org via Cloudflare's edge. Either hop can produce a
 * transient 5xx — we've seen HTTP 503 on a single tarball out of 456
 * kill a whole install. npm's client retries 5xx by default; we didn't,
 * until this file. Any single transient failure across hundreds of
 * packages = whole install dead.
 *
 * Scope:
 *   - Retries on 5xx (500/502/503/504 especially) and network errors
 *     (fetch rejection, AbortError timeout, etc.).
 *   - Does NOT retry on 4xx (those are hard: 404 means the package or
 *     version genuinely doesn't exist; retrying is wrong and wastes time).
 *   - Budget: 3 retries with jittered exponential backoff (500/1500/4500 ms
 *     ±25% jitter). Worst-case added latency per package ≈ 6.5 s in the
 *     fully-degraded path. Tighter than npm's ~5×60s because dev iteration
 *     speed matters more than absolute resilience here.
 *
 * Intentionally NOT exported to the facet isolate: the facet serializes
 * its task function via fn.toString() and can't cross a module boundary,
 * so `src/npm-install-facet.ts` duplicates this retry loop inline inside
 * `fetchAndStagePackage`. Keep the two in sync if behaviour changes.
 */
/** Default retry count AFTER the first attempt (3 = up to 4 total attempts). */
export declare const DEFAULT_RETRIES = 3;
/** Base backoff delays in ms. Index = retry attempt (0-indexed). */
export declare const BACKOFF_MS: readonly number[];
/** Jitter ±25% of the base delay, uniformly distributed. */
export declare function jittered(baseMs: number): number;
/** True if an HTTP status should trigger a retry. */
export declare function isRetriableStatus(status: number): boolean;
/**
 * Signature of a fetch-compatible callable. Lets callers inject a proxy
 * (e.g. the Nimbus supervisor-fetch RPC) without forcing global fetch.
 */
export type FetchCallable = (url: string, init?: RequestInit) => Promise<Response>;
export interface RetryableFetchOptions {
    /**
     * Retries AFTER the initial attempt. Default DEFAULT_RETRIES (3).
     * 0 = behave as a plain fetch.
     */
    retries?: number;
    /**
     * Fetch implementation. Defaults to globalThis.fetch. Pass a proxy
     * fetch (e.g. env.SUPERVISOR-backed fetchFn) to route through it while
     * keeping the retry semantics.
     */
    fetchImpl?: FetchCallable;
    /**
     * Human-readable name for the resource (used only in log messages).
     * Typically "<pkg>@<version>" for npm or the URL.
     */
    name?: string;
    /**
     * Per-attempt timeout in ms. A fresh AbortController is used per attempt
     * so a slow-to-fail upstream doesn't eat the whole retry budget on a
     * single hang. Merges with any caller-provided `init.signal` (both are
     * honored: whichever aborts first wins).
     *
     * Default: undefined (no timeout; caller is responsible for its own
     * signal if it wants one).
     */
    perAttemptTimeoutMs?: number;
    /**
     * Optional logger called on each retry decision. Signature:
     *   onRetry(attempt /* 1-indexed *\/, totalRetries, delayMs, reason)
     *
     * Caller uses this to surface visible progress ("retry 1/3 after 500ms
     * (HTTP 503)") rather than have the whole install silently hang for
     * several seconds.
     */
    onRetry?: (attempt: number, totalRetries: number, delayMs: number, reason: string) => void;
}
/**
 * fetch() wrapper with 5xx + network-error retry and jittered backoff.
 *
 * On a 4xx response, returns the Response object as-is (caller decides
 * whether that's an error). On a 5xx or network-level failure, retries
 * up to `retries` times with BACKOFF_MS[attempt] ± 25% jitter.
 *
 * When retries are exhausted, either:
 *   - Returns the last (5xx) Response, so the caller can read .status for
 *     error reporting, OR
 *   - Re-throws the last network error (caller never sees a Response).
 *
 * Callers that previously did `if (!resp.ok) throw ...` retain that shape;
 * the only change is that transient failures are recovered before the
 * throw instead of killing the whole install on the first hiccup.
 */
export declare function retryableFetch(url: string, init?: RequestInit, opts?: RetryableFetchOptions): Promise<Response>;
//# sourceMappingURL=retry.d.ts.map