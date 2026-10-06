/**
 * lost-call.ts — the one policy for a call that never reaches the session.
 *
 * The platform drops calls into a Durable Object now and then, and the
 * caller cannot tell a call that never arrived from one that is slow:
 *   - reads, SupervisorRPC → session, under three concurrent sessions
 *     (2026-09-28): 11 of 521 read batches never reached the session and
 *     were still pending 110-560 s later; every read that answered did so
 *     within 5 s;
 *   - write waves, a facet's writeBatchStream (2026-10-06, two next.js
 *     clones): the transport read the stream's first ~1 MiB within 0.1 s
 *     and nothing more, while the session held no stream, credit,
 *     allocation or transaction for it and kept committing other waves;
 *     healthy, with 8 producers saturating one session, the longest gap
 *     between a wave's reads was 2.5 s and the slowest wave 5.3 s;
 *   - calls that fail at once, "Network connection lost." (`retryable`),
 *     which classifyDoCall names.
 *
 * Detection and timings live here; the recovery depends on what a second
 * delivery would do. A read is idempotent, so it is hedged: the same call
 * on a fresh stub, the first answer taken (fabric do-calls `hedgeAfterMs`).
 * A write wave carries a stream the first attempt consumes, so it cannot be
 * hedged: it is re-encoded and re-sent under a fence (`WaveFence`), and the
 * session refuses an attempt older than one it has seen from the same
 * writer, so a late original never applies over its re-send.
 */
/** An idempotent call unanswered this long is hedged on a fresh stub. */
export declare const LOST_CALL_HEDGE_AFTER_MS = 5000;
/** A stream nothing has read for this long, before its end, never reached the session. */
export declare const LOST_STREAM_STALL_MS = 10000;
/** A call unanswered this long after its stream ended is taken as lost. */
export declare const LOST_STREAM_ANSWER_MS = 20000;
/**
 * Waits before each re-send of a lost non-idempotent call (±25% jitter):
 * ~42 s in all, to outlast a coordinator queue deep enough to shed. Its
 * length is the bound on re-sends.
 */
export declare const LOST_CALL_RESEND_BACKOFF_MS: readonly number[];
/**
 * Whether `error` is the platform losing a fenced call: a dropped
 * connection, a replaced isolate, a storage reset, or an object that shed
 * it. Overloaded is included for fenced re-sends only: the platform's advice
 * is not to retry an overloaded object, but these are few and backed off,
 * and npm measured one re-send recover a 119-package install that one shed
 * cost 31 packages (do-calls' unfenced verbs still never retry it).
 */
export declare function isLostFencedCall(error: unknown): boolean;
/** The attributes a lost call is logged and traced under, by every caller. */
export declare function lostCallAttributes(lost: {
    operation: string;
    attempt: number;
    of: number;
    reason: string;
}): Record<string, string | number>;
//# sourceMappingURL=lost-call.d.ts.map