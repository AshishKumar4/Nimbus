/**
 * do-calls.ts — the two verbs for calling another Durable Object, split by
 * the one property that decides whether a retry is safe.
 *
 * Both consumers asked for this. Proteus hand-wrote the retry
 * (`cf-backend/src/lib/do-rpc.ts`) with the rule its header states:
 * "An operation that appends, sends, charges or mints is never wrapped: a
 * dropped call there may already have run, so a retry is a correctness bug
 * wearing resilience as a costume." agent-core has no retry machinery at all
 * and its backlog calls the gap "the most production-proven gap in the
 * corpus". Here the rule is a type: `idempotent` retries, `mutating` cannot.
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
 * read, or a converge-to-a-value write. Transient failures retry on a fresh
 * stub with full-jitter backoff; overloaded and permanent failures surface
 * unchanged, as does the last error at exhaustion.
 */
export async function idempotent(operation, stub, call, policy = {}) {
    const maxAttempts = policy.maxAttempts ?? MAX_ATTEMPTS;
    const baseDelayMs = policy.baseDelayMs ?? BASE_DELAY_MS;
    for (let attempt = 1;; attempt++) {
        const minted = await stub();
        try {
            const result = await call(minted);
            disposeRpcResource(minted);
            return result;
        }
        catch (error) {
            // A stub that threw may be permanently broken; it is never reused.
            disposeRpcResource(minted);
            const classification = classifyDoCall(error);
            if (!isRetryableDoCall(classification) || attempt >= maxAttempts)
                throw error;
            policy.onRetry?.({ operation, classification, attempt, maxAttempts, error });
            await new Promise((resolve) => {
                setTimeout(resolve, Math.floor(Math.random() * 2 ** attempt * baseDelayMs));
            });
        }
    }
}
/**
 * Call another Durable Object with an operation that appends, sends, charges
 * or mints. NEVER retried — a dropped call may already have run. Failure
 * surfaces as a {@link DoCallError} carrying the classification, so the
 * caller can tell a refusal from an indeterminate drop.
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
