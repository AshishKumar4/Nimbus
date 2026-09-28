/**
 * do-calls.ts — the two verbs for calling another Durable Object, split by
 * the one property that decides whether a retry is safe.
 *
 * Both consumers asked for this. Proteus hand-wrote the retry
 * (originally `cf-backend/src/lib/do-rpc.ts`) with the rule its header states:
 * "An operation that appends, sends, charges or mints is never wrapped: a
 * dropped call there may already have run, so a retry is a correctness bug
 * wearing resilience as a costume." agent-core has no retry machinery at all
 * and its backlog calls the gap "the most production-proven gap in the
 * corpus". Here the rule is a type: `idempotent` retries, `mutating` cannot.
 * A mutation earns a retry only by carrying an identity its callee applies
 * at most once; it is then `idempotent` by construction (see `mutating`).
 *
 * What the platform contract requires, and this keeps:
 *   - a FRESH stub per attempt. Cloudflare documents that many exceptions
 *     leave a stub permanently broken, so both verbs take a stub RESOLVER,
 *     not a stub — which is also what lets placement pins and auth wrappers
 *     compose (agent-core's PlacementResolver pins an Actor to one
 *     jurisdiction for life; the resolver seam is where that lives).
 *   - `overloaded` is never retried, by either verb: retrying an overloaded
 *     object is what overloaded it.
 *   - attempts and backoff are the consumer-proven bounds: 3 attempts total,
 *     full-jitter delays in [0, 2**attempt * 60ms).
 *   - an `idempotent` call may also be HEDGED (`hedgeAfterMs`): an attempt
 *     that has not answered by then is joined by the same call on a fresh
 *     stub, both left running, the first success taken. Hedges count
 *     against the attempts, and a callee that joins a repeat to the call it
 *     is already serving makes one that did arrive cost nothing.
 *
 * The resolver MINTS a stub per call and the verb disposes each one it
 * minted — that ownership is what makes the fresh-stub retry real.
 *
 * The stub method call itself happens inside the CALLER's closure
 * (`(stub) => stub.method(args)`): nothing here proxies property resolution
 * or dispatches by method name. Do NOT use these verbs around a dynamically
 * loaded worker's entrypoint stub — those calls must stay direct property
 * calls bracketed by `beginLoaderFetch` (budgets.ts records the 7/7 staging
 * poisoning that rule comes from). These verbs are for Durable Object
 * namespace stubs, where the thunk shape is production-proven in Proteus.
 */
import { type DoCallClass } from '@nimbus-sh/platform/oom-classify.js';
export interface DoCallRetryPolicy {
    maxAttempts?: number;
    baseDelayMs?: number;
    /**
     * No repeat — retry or hedge — starts once this long has passed since the
     * first attempt did; the failure in hand surfaces instead. A mutation made
     * repeatable by an identity its callee dedupes needs it: the callee keeps
     * what answers a repeat for a bounded time, so the caller's repeats must
     * stop well inside it. Unbounded when absent.
     */
    retryWindowMs?: number;
    /**
     * Hedge an attempt that has not answered after this long: send the same
     * call again on a fresh stub while the first stays in flight. The caller
     * gets the first success; an answer after it is disposed and dropped. That
     * is only harmless when a second delivery of the call changes nothing — a
     * read — and cheap only when the callee joins a repeat to the call it is
     * already serving. A hedge is an attempt: it counts against `maxAttempts`,
     * and has its own deadline. Never hedged when absent.
     *
     * With attempts overlapping, a failure decides less. A retryable one is
     * retried after its backoff while attempts remain. One that is not stops
     * every further repeat. Either way the call keeps waiting on the attempts
     * still in flight, and fails with the last failure only once none is.
     */
    hedgeAfterMs?: number;
    /**
     * Called once per retry, as it starts — after its backoff delay — with the
     * failure the retry is answering. A retry a hedge made unnecessary, or
     * that no attempt is left for, is never announced. The consumer's logging
     * seam: Proteus's hand-rolled predecessor logged every retry so a flaky
     * object is visible in Workers Logs rather than silently absorbed, and
     * `operation` names it there. A callback that throws fails the call with
     * its error.
     */
    onRetry?(info: DoCallRetryInfo): void;
}
/** What one retry is answering: which call, which platform class, which
 *  attempt just failed out of how many. */
export interface DoCallRetryInfo {
    operation: string;
    classification: DoCallClass;
    /**
     * The 1-based number of the attempt that failed. Without hedging the retry
     * is attempt+1; with it, other attempts may have started in between.
     */
    attempt: number;
    maxAttempts: number;
    error: unknown;
}
/**
 * Mints one stub per call. `idempotent` calls it once per attempt.
 *
 * MINT means mint. Both verbs dispose the stub they were handed when the
 * call settles — on success as much as on failure (`disposeRpcResource`).
 * A resolver that returns a shared, long-lived stub hands its other users
 * a disposed stub, and only in production: a test double is a plain object
 * with nothing to dispose, so the test stays green while the deployed
 * Worker breaks on the second call.
 */
export type DoStubResolver<S> = () => S | Promise<S>;
/**
 * A failed `mutating` call, typed so the caller can act on WHAT failed:
 * `classification` names the platform condition, and a transient class on a
 * mutating call means the call may already have run — the indeterminacy the
 * consumer's rule exists to surface rather than paper over.
 */
export declare class DoCallError extends Error {
    readonly operation: string;
    readonly verb: 'idempotent' | 'mutating';
    readonly classification: DoCallClass;
    constructor(operation: string, verb: 'idempotent' | 'mutating', classification: DoCallClass, cause: unknown);
}
/**
 * Call another Durable Object with an operation that is safe to repeat: a
 * read, a converge-to-a-value write, or a mutation carrying an identity its
 * callee applies at most once (see {@link mutating}). Transient failures
 * retry on a fresh stub with full-jitter backoff; overloaded and permanent
 * failures surface unchanged, as does the last error once no attempt may be
 * repeated — attempts spent, or the policy's retry window closed. With
 * `hedgeAfterMs`, an attempt still unanswered by then is joined by another
 * on a fresh stub, and the first success is taken; a failure then ends the
 * call only once no attempt is left in flight.
 *
 * A failure of the resolver or of `onRetry` is the caller's own, and fails
 * the call with it at once.
 */
export declare function idempotent<S, T>(operation: string, stub: DoStubResolver<S>, call: (stub: S) => Promise<T>, policy?: DoCallRetryPolicy): Promise<T>;
/**
 * Call another Durable Object with an operation that appends, sends, charges
 * or mints. NEVER retried — a dropped call may already have run. Failure
 * surfaces as a {@link DoCallError} carrying the classification, so the
 * caller can tell a refusal from an indeterminate drop.
 *
 * The rule is about the call as sent, not the operation's kind. A mutation
 * the callee applies at most once per identity the call carries is
 * repeatable by construction: a repeat of one that already ran is answered
 * from the callee's record and applies nothing. Nimbus has two:
 *   - delivered filesystem mutations (@nimbus-sh/core supervisor-delivery):
 *     a delivery id plus the callee INSTANCE's incarnation. The record lives
 *     in that instance's memory, and any other instance — or a callee that
 *     predates delivery — refuses the call permanently rather than apply it
 *     without one;
 *   - appends: writer, module incarnation and operation sequence, recorded
 *     durably until acknowledged.
 * Such a call goes through {@link idempotent}, re-sending the same identity
 * on every attempt, with a `retryWindowMs` inside the callee's retention of
 * that record. Without such an identity, a mutation stays here.
 */
export declare function mutating<S, T>(operation: string, stub: DoStubResolver<S>, call: (stub: S) => Promise<T>): Promise<T>;
//# sourceMappingURL=do-calls.d.ts.map