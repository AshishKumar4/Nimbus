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
import { classifyDoCall, isRetryableDoCall } from '@nimbus-sh/platform/oom-classify.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
/** Total attempts. Two retries is what a dropped connection or a deploy
 *  bounce needs; beyond that the object is not coming back inside this
 *  request (the consumer's measured bound). */
const MAX_ATTEMPTS = 3;
/** Full-jitter base, in the shape the Agents SDK itself uses. */
const BASE_DELAY_MS = 60;
/**
 * A failed `mutating` call, typed so the caller can act on WHAT failed:
 * `classification` names the platform condition, and a transient class on a
 * mutating call means the call may already have run — the indeterminacy the
 * consumer's rule exists to surface rather than paper over.
 */
export class DoCallError extends Error {
    operation;
    verb;
    classification;
    constructor(operation, verb, classification, cause) {
        const text = cause instanceof Error ? cause.message : String(cause);
        const indeterminate = isRetryableDoCall(classification)
            ? ' — a dropped mutating call may already have run, so it is not retried'
            : '';
        super(`${verb} call '${operation}' failed [${classification}]: ${text}${indeterminate}`, { cause });
        this.operation = operation;
        this.verb = verb;
        this.classification = classification;
        this.name = 'DoCallError';
    }
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
export function idempotent(operation, stub, call, policy = {}) {
    const maxAttempts = policy.maxAttempts ?? MAX_ATTEMPTS;
    const baseDelayMs = policy.baseDelayMs ?? BASE_DELAY_MS;
    const { hedgeAfterMs, retryWindowMs } = policy;
    const startedAt = Date.now();
    // The executor form: fabric's library target predates Promise.withResolvers.
    return new Promise((resolve, reject) => {
        const hedges = new Set();
        let started = 0;
        // Attempts in flight, or backing off before their retry: while one is,
        // a failure is not the call's answer.
        let live = 0;
        // A failure that is not transient: nothing is repeated after it.
        let refused = false;
        let settled = false;
        const settle = (answer) => {
            if (settled)
                return;
            settled = true;
            for (const timer of hedges)
                clearTimeout(timer);
            hedges.clear();
            answer();
        };
        /** May another attempt start at `at`? */
        const canRepeat = (at) => !settled && !refused && started < maxAttempts
            && (retryWindowMs === undefined || at - startedAt <= retryWindowMs);
        /** `error` ended an attempt that will not be repeated: the call's answer, once nothing else is live. */
        const exhausted = (error) => {
            if (live === 0)
                settle(() => reject(error));
        };
        /** A failed attempt, numbered: repeat it after its backoff, or let it stand. */
        const failed = async (number, error) => {
            if (settled)
                return;
            const classification = classifyDoCall(error);
            if (!isRetryableDoCall(classification)) {
                refused = true;
                exhausted(error);
                return;
            }
            const delayMs = Math.floor(Math.random() * 2 ** number * baseDelayMs);
            if (!canRepeat(Date.now() + delayMs)) {
                exhausted(error);
                return;
            }
            live++;
            await new Promise((wake) => {
                setTimeout(wake, delayMs);
            });
            live--;
            // A hedge may have taken the last attempt, or answered, meanwhile.
            if (!canRepeat(Date.now())) {
                exhausted(error);
                return;
            }
            policy.onRetry?.({ operation, classification, attempt: number, maxAttempts, error });
            attempt();
        };
        const run = async () => {
            const number = ++started;
            live++;
            const minted = await stub();
            if (settled) {
                live--;
                disposeRpcResource(minted);
                return;
            }
            const hedge = hedgeAfterMs === undefined ? undefined : setTimeout(() => {
                if (hedge !== undefined)
                    hedges.delete(hedge);
                if (canRepeat(Date.now()))
                    attempt();
            }, hedgeAfterMs);
            if (hedge !== undefined)
                hedges.add(hedge);
            /** This attempt has its answer: it hedges no more, and its stub goes. */
            const answered = () => {
                if (hedge !== undefined) {
                    clearTimeout(hedge);
                    hedges.delete(hedge);
                }
                live--;
                // A stub that threw may be permanently broken; none is ever reused.
                disposeRpcResource(minted);
            };
            let result;
            try {
                result = await call(minted);
            }
            catch (error) {
                answered();
                await failed(number, error);
                return;
            }
            answered();
            if (settled) {
                // Another attempt answered first: this answer is dropped, so nothing of it is kept.
                disposeRpcResource(result);
                return;
            }
            settle(() => resolve(result));
        };
        /** Start an attempt. Whatever it throws outside the call itself fails the call. */
        const attempt = () => {
            run().catch((error) => settle(() => reject(error)));
        };
        attempt();
    });
}
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
export async function mutating(operation, stub, call) {
    const minted = await stub();
    try {
        const result = await call(minted);
        disposeRpcResource(minted);
        return result;
    }
    catch (error) {
        disposeRpcResource(minted);
        throw new DoCallError(operation, 'mutating', classifyDoCall(error), error);
    }
}
