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
export const DEFAULT_RETRIES = 3;

/** Base backoff delays in ms. Index = retry attempt (0-indexed). */
export const BACKOFF_MS: readonly number[] = [500, 1500, 4500];

/** Jitter ±25% of the base delay, uniformly distributed. */
export function jittered(baseMs: number): number {
  const span = baseMs * 0.25;
  // Math.random is fine here — cryptographic randomness is not required;
  // the goal is to break up synchronized retries across concurrent fetches
  // after a shared upstream hiccup.
  return Math.max(0, Math.round(baseMs + (Math.random() * 2 - 1) * span));
}

/** True if an HTTP status should trigger a retry. */
export function isRetriableStatus(status: number): boolean {
  // 5xx only. 429 (Too Many Requests) is arguably retriable too, but
  // registry.npmjs.org is fronted by Cloudflare which generally rate-
  // limits per-IP silently rather than with 429, and if we ever DO see
  // 429 the right handling is Retry-After header honor, which we don't
  // implement here. Keep the surface minimal.
  return status >= 500 && status <= 599;
}

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
export async function retryableFetch(
  url: string,
  init?: RequestInit,
  opts?: RetryableFetchOptions,
): Promise<Response> {
  const totalRetries = Math.max(0, opts?.retries ?? DEFAULT_RETRIES);
  const name = opts?.name ?? url;
  const doFetch: FetchCallable = opts?.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchCallable);
  let lastError: unknown;
  let lastResp: Response | undefined;

  for (let attempt = 0; attempt <= totalRetries; attempt++) {
    // Per-attempt timeout via a fresh AbortController so a single slow
    // response can't consume the whole retry budget. We merge the caller's
    // signal (if any) by forwarding its abort to ours.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attemptInit: RequestInit | undefined = init;
    const perAttemptMs = opts?.perAttemptTimeoutMs;
    let localController: AbortController | undefined;
    if (perAttemptMs && perAttemptMs > 0) {
      localController = new AbortController();
      timer = setTimeout(() => localController!.abort(), perAttemptMs);
      const callerSignal = init?.signal;
      if (callerSignal) {
        if (callerSignal.aborted) localController.abort();
        else callerSignal.addEventListener('abort', () => localController!.abort(), { once: true });
      }
      attemptInit = { ...(init ?? {}), signal: localController.signal };
    }
    try {
      const resp = await doFetch(url, attemptInit);
      if (timer) clearTimeout(timer);
      if (resp.ok || !isRetriableStatus(resp.status)) {
        // Success or 4xx — don't retry. Return as-is; caller checks .ok.
        return resp;
      }
      // 5xx: drain the body to release the underlying stream.
      try { await resp.body?.cancel(); } catch { /* best-effort */ }
      lastResp = resp;
      lastError = undefined;
      if (attempt === totalRetries) {
        // Out of retries — return the 5xx Response so the caller can
        // surface the final status. Caller (e.g. npm-resolver.ts) is
        // responsible for disposing the stub via Symbol.dispose after
        // reading status. (Matches the previous !resp.ok throw shape if
        // the caller checks .ok next.)
        return resp;
      }
      // We're going to retry — dispose the stub NOW so it doesn't leak.
      //
      // When `doFetch` is the supervisor's fetch-proxy entrypoint
      // (src/nimbus-session.ts:1729-1747), `resp` is an RPC stub returned
      // from `entrypoint.fetch(...)`. Workerd auto-disposes such stubs
      // only at the end of the enclosing event-handler context — which
      // for `npm install` means "until the whole install completes".
      // Cancelling `resp.body` (above) releases the underlying stream
      // but does NOT release the stub itself. Across an install with N
      // retries fired, that's N leaked stubs accumulating alongside the
      // resolver's own per-packument stubs (already disposed in
      // npm-resolver.ts:307-317). Each leaked stub keeps its server-side
      // counterpart pinned until the deferred-destruction queue runs at
      // request end, contributing to the queueState != ACTIVE fatal
      // documented in WORKERD-CRASH.md.
      //
      // Same disposer pattern as src/npm-resolver.ts:312-316.
      try {
        const disposerKey = (Symbol as any).dispose;
        const disposer = disposerKey ? (resp as any)?.[disposerKey] : undefined;
        if (typeof disposer === 'function') disposer.call(resp);
      } catch { /* best-effort */ }
      const delayMs = jittered(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
      opts?.onRetry?.(attempt + 1, totalRetries, delayMs, `HTTP ${resp.status}`);
      await new Promise<void>((r) => setTimeout(r, delayMs));
    } catch (e: any) {
      if (timer) clearTimeout(timer);
      // Network-level failure (fetch rejection, timeout via AbortError,
      // DNS, connection reset). Retry the same way as a 5xx.
      lastError = e;
      lastResp = undefined;
      if (attempt === totalRetries) {
        throw e;
      }
      const delayMs = jittered(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
      const reason = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e));
      opts?.onRetry?.(attempt + 1, totalRetries, delayMs, reason);
      await new Promise<void>((r) => setTimeout(r, delayMs));
    }
  }

  // Unreachable: the loop either returns (on success / non-retriable /
  // final 5xx) or throws (on final network error).
  if (lastResp) return lastResp;
  throw lastError ?? new Error(`retryableFetch: exhausted for ${name}`);
}
