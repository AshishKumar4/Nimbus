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
 *     stub, both left running, the first answer taken. Hedges count against
 *     the attempts.
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

import { classifyDoCall, isRetryableDoCall, type DoCallClass } from '@nimbus-sh/platform/oom-classify.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';

/** Total attempts. Two retries is what a dropped connection or a deploy
 *  bounce needs; beyond that the object is not coming back inside this
 *  request (the consumer's measured bound). */
const MAX_ATTEMPTS = 3;
/** Full-jitter base, in the shape the Agents SDK itself uses. */
const BASE_DELAY_MS = 60;

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
   * call again on a fresh stub while the first stays in flight, and take
   * whichever answers first. The late answer, if one comes, is disposed and
   * dropped, so the caller sees one result — which is only harmless when a
   * second delivery of the call changes nothing, a read. A hedge is an
   * attempt: it counts against `maxAttempts`, and each has its own deadline.
   * A failure the platform marks retryable is waited out while another
   * attempt is still in flight, and retried once none is. Never hedged when
   * absent.
   */
  hedgeAfterMs?: number;
  /**
   * Called once per retry, before its backoff delay, with the failure the
   * retry is answering. The consumer's logging seam: Proteus's hand-rolled
   * predecessor logged every retry so a flaky object is visible in Workers
   * Logs rather than silently absorbed, and `operation` names it there.
   */
  onRetry?(info: DoCallRetryInfo): void;
}

/** What one retry is answering: which call, which platform class, which
 *  attempt just failed out of how many. */
export interface DoCallRetryInfo {
  operation: string;
  classification: DoCallClass;
  /** The 1-based attempt that failed; the retry about to run is attempt+1. */
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
export class DoCallError extends Error {
  constructor(
    readonly operation: string,
    readonly verb: 'idempotent' | 'mutating',
    readonly classification: DoCallClass,
    cause: unknown,
  ) {
    const text = cause instanceof Error ? cause.message : String(cause);
    const indeterminate = isRetryableDoCall(classification)
      ? ' — a dropped mutating call may already have run, so it is not retried'
      : '';
    super(`${verb} call '${operation}' failed [${classification}]: ${text}${indeterminate}`, { cause });
    this.name = 'DoCallError';
  }
}

/**
 * Call another Durable Object with an operation that is safe to repeat: a
 * read, a converge-to-a-value write, or a mutation carrying an identity its
 * callee applies at most once (see {@link mutating}). Transient failures
 * retry on a fresh stub with full-jitter backoff; overloaded and permanent
 * failures surface unchanged, as does the last error once the attempts are
 * spent and none is left in flight, or once the policy's retry window has
 * closed. With `hedgeAfterMs`, an attempt still unanswered by then is
 * joined by another on a fresh stub, and the first answer is taken.
 */
export function idempotent<S, T>(
  operation: string,
  stub: DoStubResolver<S>,
  call: (stub: S) => Promise<T>,
  policy: DoCallRetryPolicy = {},
): Promise<T> {
  const maxAttempts = policy.maxAttempts ?? MAX_ATTEMPTS;
  const baseDelayMs = policy.baseDelayMs ?? BASE_DELAY_MS;
  const { hedgeAfterMs, retryWindowMs } = policy;
  const startedAt = Date.now();
  // The executor form: fabric's library target predates Promise.withResolvers.
  return new Promise<T>((resolve, reject) => {
    const hedgeTimers = new Set<ReturnType<typeof setTimeout>>();
    let sent = 0;
    let inFlight = 0;
    let settled = false;

    const settle = (answer: () => void): void => {
      if (settled) return;
      settled = true;
      for (const timer of hedgeTimers) clearTimeout(timer);
      hedgeTimers.clear();
      answer();
    };
    const repeatAllowedAt = (at: number): boolean => retryWindowMs === undefined || at - startedAt <= retryWindowMs;

    const attempt = async (): Promise<void> => {
      sent++;
      inFlight++;
      let minted: S;
      try {
        minted = await stub();
      } catch (error) {
        inFlight--;
        settle(() => reject(error));
        return;
      }
      if (settled) {
        inFlight--;
        disposeRpcResource(minted);
        return;
      }
      let answered = false;
      if (hedgeAfterMs !== undefined) {
        const timer = setTimeout(() => {
          hedgeTimers.delete(timer);
          if (settled || answered || sent >= maxAttempts || !repeatAllowedAt(Date.now())) return;
          void attempt();
        }, hedgeAfterMs);
        hedgeTimers.add(timer);
      }
      let result: T;
      try {
        result = await call(minted);
      } catch (error) {
        answered = true;
        inFlight--;
        // A stub that threw may be permanently broken; it is never reused.
        disposeRpcResource(minted);
        if (settled) return;
        const classification = classifyDoCall(error);
        if (!isRetryableDoCall(classification)) {
          settle(() => reject(error));
          return;
        }
        if (sent >= maxAttempts) {
          // An attempt still in flight may yet answer; the last to fail says why none did.
          if (inFlight === 0) settle(() => reject(error));
          return;
        }
        const delayMs = Math.floor(Math.random() * 2 ** sent * baseDelayMs);
        if (!repeatAllowedAt(Date.now() + delayMs)) {
          if (inFlight === 0) settle(() => reject(error));
          return;
        }
        policy.onRetry?.({ operation, classification, attempt: sent, maxAttempts, error });
        await new Promise<void>((wake) => {
          setTimeout(wake, delayMs);
        });
        if (settled) return;
        // A hedge may have taken the last attempt during the backoff.
        if (sent < maxAttempts) void attempt();
        else if (inFlight === 0) settle(() => reject(error));
        return;
      }
      answered = true;
      inFlight--;
      disposeRpcResource(minted);
      if (settled) {
        // A hedge answered first; this answer is dropped, so nothing of it is kept.
        disposeRpcResource(result);
        return;
      }
      settle(() => resolve(result));
    };

    void attempt();
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
export async function mutating<S, T>(
  operation: string,
  stub: DoStubResolver<S>,
  call: (stub: S) => Promise<T>,
): Promise<T> {
  const minted = await stub();
  try {
    const result = await call(minted);
    disposeRpcResource(minted);
    return result;
  } catch (error) {
    disposeRpcResource(minted);
    throw new DoCallError(operation, 'mutating', classifyDoCall(error), error);
  }
}
