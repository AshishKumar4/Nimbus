/**
 * retry.ts — the one retry policy: the loop that tries an operation again
 * when its outcome is worth another try, and the wait between tries.
 *
 * Each caller names what is worth another try and how far apart, because
 * that is what differs and was measured per transport:
 *   - the npm registry (npm/registry-retry.ts): a 5xx or a request that
 *     never answered, 500/1500/4500 ms;
 *   - a git server (git/pack/transport.ts): an idempotent request that
 *     failed in transit, stalled, or met a transient edge status, 1/3 s;
 *   - a lost write wave (lost-call.ts LOST_CALL_RESEND_BACKOFF_MS).
 * Every wait is its schedule's entry ±25%, uniformly, so concurrent callers
 * that failed together do not try again together.
 *
 * Self-contained, both functions: a facet that cannot import carries them
 * by source (fn.toString(); the npm install facet's preamble does).
 */
/**
 * The wait before re-try `attempt` (0-based, the try that just failed):
 * `schedule[attempt]`, its last entry once past the end, ±25%.
 */
export function retryDelayMs(schedule, attempt) {
    const base = schedule[Math.min(attempt, schedule.length - 1)] ?? 0;
    return Math.max(0, Math.round(base + (Math.random() * 2 - 1) * base * 0.25));
}
/**
 * `attempt(n)` for n = 0, 1, … until its outcome is not worth another try
 * or the policy's re-tries are spent; then that outcome: its value
 * returned, its error thrown.
 */
export async function retrying(attempt, policy) {
    for (let n = 0;; n++) {
        let outcome;
        try {
            outcome = { ok: true, value: await attempt(n) };
        }
        catch (error) {
            outcome = { ok: false, error };
        }
        const reason = n < policy.retries ? policy.retryReason(outcome) : null;
        if (reason === null) {
            if (outcome.ok)
                return outcome.value;
            throw outcome.error;
        }
        if (outcome.ok && policy.discard) {
            try {
                await policy.discard(outcome.value);
            }
            catch {
                // It is being given up either way.
            }
        }
        const delayMs = retryDelayMs(policy.schedule, n);
        policy.onRetry?.(n + 1, policy.retries, delayMs, reason);
        // The executor form: this package's lib (ES2022) has no Promise.withResolvers.
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
}
