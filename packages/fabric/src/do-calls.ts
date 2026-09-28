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

import { classifyDoCall, isRetryableDoCall, type DoCallClass } from '@nimbus-sh/platform/oom-classify.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { untraced, type SpanRecorder } from '@nimbus-sh/platform/tracing.js';

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
   * call again on a fresh stub while the first stays in flight. The caller
   * gets the first success; an answer after it is disposed and dropped. That
   * is only harmless when a second delivery of the call changes nothing — a
   * read — and cheap only when the callee joins a repeat to the call it is
   * already serving. A hedge is an attempt: it counts against `maxAttempts`,
   * and has its own deadline. Never hedged when absent.
   *
   * With attempts overlapping, a failure decides less. A retryable one is
   * retried after its backoff while attempts remain, and `overloaded` stops
   * every further repeat; either way the call keeps waiting on the attempts
   * still in flight, and fails with the last failure only once none is. Any
   * other failure is the callee's answer — the call ran — and is the call's
   * at once.
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
  /**
   * Where the call's telemetry goes: its span's recorder. Each attempt lost
   * to a transient or overloaded failure is recorded as an exception whose
   * `code` is the failure's class, and once the call has settled it gets
   * `do_call.attempts` (started), `do_call.hedges` (started by a hedge),
   * `do_call.answered_by` (the attempt whose answer the call took, absent
   * when none answered) and `do_call.outcome` ({@link DoCallOutcome}).
   * Nothing recorded can change the call's answer. Records nothing when
   * absent.
   */
  span?: SpanRecorder;
}

/**
 * How an `idempotent` call ended: `answered` (an attempt succeeded),
 * `callee_error` (the callee's own failure, which is an answer),
 * `exhausted` (the last transient failure, no repeat left), `overloaded`
 * (shed, nothing repeated after it), or `caller_error` (the resolver or
 * `onRetry` threw).
 */
export type DoCallOutcome = 'answered' | 'callee_error' | 'exhausted' | 'overloaded' | 'caller_error';

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
 * failures surface unchanged, as does the last error once no attempt may be
 * repeated — attempts spent, or the policy's retry window closed. With
 * `hedgeAfterMs`, an attempt still unanswered by then is joined by another
 * on a fresh stub, and the first answer is taken: a success, or the
 * callee's own error. A transient or overloaded failure then ends the call
 * only once no attempt is left in flight.
 *
 * A failure of the resolver or of `onRetry` is the caller's own, and fails
 * the call with it at once.
 */
export function idempotent<S, T>(
  operation: string,
  stub: DoStubResolver<S>,
  call: (stub: S) => Promise<T>,
  policy: DoCallRetryPolicy = {},
): Promise<T> {
  const maxAttempts = policy.maxAttempts ?? MAX_ATTEMPTS;
  const baseDelayMs = policy.baseDelayMs ?? BASE_DELAY_MS;
  const { hedgeAfterMs, retryWindowMs, span = untraced } = policy;
  const startedAt = Date.now();
  // The executor form: fabric's library target predates Promise.withResolvers.
  return new Promise<T>((resolve, reject) => {
    const hedges = new Set<ReturnType<typeof setTimeout>>();
    let started = 0;
    // Attempts in flight, or backing off before their retry: while one is,
    // a failure is not the call's answer.
    let live = 0;
    // An attempt was shed as overloaded: nothing is repeated after it.
    let refused = false;
    let settled = false;
    // Attempts a hedge started rather than a retry or the first send.
    let hedged = 0;

    const settle = (outcome: DoCallOutcome, answeredBy: number | undefined, answer: () => void): void => {
      if (settled) return;
      settled = true;
      for (const timer of hedges) clearTimeout(timer);
      hedges.clear();
      answer();
      span.set({
        'do_call.attempts': started,
        'do_call.hedges': hedged,
        'do_call.answered_by': answeredBy,
        'do_call.outcome': outcome,
      });
    };
    /** May another attempt start at `at`? */
    const canRepeat = (at: number): boolean =>
      !settled && !refused && started < maxAttempts
      && (retryWindowMs === undefined || at - startedAt <= retryWindowMs);
    /** `error` ended an attempt that will not be repeated: the call's answer, once nothing else is live. */
    const exhausted = <E>(error: E): void => {
      if (live === 0) settle(refused ? 'overloaded' : 'exhausted', undefined, () => reject(error));
    };

    /** A failed attempt, numbered: repeat it after its backoff, or let it stand. */
    const failed = async <E>(number: number, error: E): Promise<void> => {
      if (settled) return;
      const classification = classifyDoCall(error);
      if (!isRetryableDoCall(classification) && classification !== 'overloaded') {
        // The call ran and its answer is this error — ENOENT is a read's answer as much as bytes are.
        settle('callee_error', number, () => reject(error));
        return;
      }
      // A lost attempt: the call's span says which, and why.
      span.exception(error, classification, `attempt ${number} of ${maxAttempts}: `);
      if (classification === 'overloaded') {
        // A shed call is no answer: nothing more is sent, and an attempt
        // still in flight may yet answer.
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
      await new Promise<void>((wake) => {
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

    const run = async (): Promise<void> => {
      const number = ++started;
      live++;
      const minted = await stub();
      if (settled) {
        live--;
        disposeRpcResource(minted);
        return;
      }
      const hedge = hedgeAfterMs === undefined ? undefined : setTimeout(() => {
        if (hedge !== undefined) hedges.delete(hedge);
        if (canRepeat(Date.now())) {
          hedged++;
          attempt();
        }
      }, hedgeAfterMs);
      if (hedge !== undefined) hedges.add(hedge);
      /** This attempt has its answer: it hedges no more, and its stub goes. */
      const answered = (): void => {
        if (hedge !== undefined) {
          clearTimeout(hedge);
          hedges.delete(hedge);
        }
        live--;
        // A stub that threw may be permanently broken; none is ever reused.
        disposeRpcResource(minted);
      };
      let result: T;
      try {
        result = await call(minted);
      } catch (error) {
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
      settle('answered', number, () => resolve(result));
    };

    /** Start an attempt. Whatever it throws outside the call itself fails the call. */
    const attempt = (): void => {
      run().catch((error) => settle('caller_error', undefined, () => reject(error)));
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
