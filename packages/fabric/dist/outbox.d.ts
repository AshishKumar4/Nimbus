/**
 * outbox.ts — a durable retry outbox over a Durable Object's own SQLite.
 *
 * Proteus built this discipline twice by hand and says so: its email outbox
 * (`cf-backend/src/email/outbox.ts:7` — "The discipline mirrors the peer
 * outbox", 8 attempts from a 30s base) and its peer transport
 * (`core/src/events/ingress/peer.ts` — 8 attempts from a 5s base, per-receiver
 * ordering, an ask/reply waiter over the same rows). Both carry the same
 * mechanism: a write-ahead intent row in `state='pending'`, an
 * `attempt_count`, a `next_attempt_at` with a partial index over pending rows,
 * backoff `next = now + base * 2**(attempts-1)`, and a `nextRetryAt()` folded
 * into the object's single alarm. This module is that mechanism once.
 *
 * What the consumers proved and this keeps:
 *   - WRITE-AHEAD. The row commits before send runs. On a Durable Object the
 *     output gate orders it: an outbound message cannot leave before the
 *     writes of its turn are durable, so no explicit sync is needed here.
 *   - DISPOSITION, not a boolean. peer.ts:476-526 separates three failures: a
 *     RESOLVED refusal is permanent (dlq now), a THROWN send is transport
 *     trouble (backoff), a malformed row is poison (dlq now, no send). A
 *     boolean cannot carry that, and retrying a refusal re-offends.
 *   - ORDERING per key. Rows drain in id order. A transient failure blocks
 *     later rows with the same order key until the head clears (peer.ts:465
 *     head-of-line set); a dead-lettered head does not block, and keyless rows
 *     never block each other (the email outbox has no ordering at all).
 *   - IDEMPOTENCY. A dedupe key already queued or sent is refused with the
 *     existing id, and a sent key never reaches send again.
 *
 * What the consumers lacked and this adds:
 *   - The drain registers with `timers` (one reason in the shared map) instead
 *     of owning an alarm, and the dispatch-side handler re-arms through its
 *     RETURN value — calling schedule() from inside the dispatcher's chain
 *     would deadlock on the chain that serializes the reason map.
 *   - The drain is turn-bounded through a {@link TurnBudget}: both consumer
 *     drains iterate every due row in one turn, which is the same
 *     thread-holding shape the pacer exists to end.
 */
import { type TimerContext, type TimerHandlerResult, type TimerHost, type TimerStorage } from './timers.js';
import type { TurnBudget } from './turn-budget.js';
/** Synchronous DO SQLite, as the outbox uses it. `exec` returns row objects. */
export interface OutboxSqlExec {
    exec(query: string, ...bindings: Array<string | number | null>): Iterable<unknown>;
}
/** The hosting actor's storage: its SQLite plus the shared timer map's keys. */
export interface OutboxStorage extends TimerStorage {
    sql: OutboxSqlExec;
}
export interface OutboxContext extends TimerContext {
    storage: OutboxStorage;
}
/**
 * What one send attempt concluded. A resolved `retry` and a thrown send are
 * the same transient class; `poison` is the resolved refusal that must never
 * be retried — the split the peer transport proved necessary.
 */
export type OutboxDisposition = {
    status: 'sent';
} | {
    status: 'retry';
    reason: string;
} | {
    status: 'poison';
    reason: string;
};
export interface OutboxPolicy<M, C = void> {
    /** Attempts before a row dead-letters. Email uses 8; peer uses 8. */
    maxAttempts: number;
    /** Backoff base: `next = now + baseMs * 2**(attempts-1)`. */
    baseMs: number;
    /**
     * Per-key delivery order (the peer transport's per-receiver key). Rows
     * without a key deliver independently, as the email outbox's do.
     */
    orderBy?(message: M): string;
    /**
     * Deliver one message. Throwing is transient, same as `retry`. `context`
     * is the caller's per-drain state — Proteus's email outbox resolves its
     * transport binding per call, and a policy closed at construction cannot
     * hold it (the ported consumer smuggled it through an instance field).
     */
    send(message: M, info: {
        id: string;
        attempt: number;
    }, context: C): Promise<OutboxDisposition>;
}
/**
 * `context` carries the caller's per-drain state into `send`. Required when
 * the policy declares one; absent (and unpayable) when it does not.
 */
export type OutboxDrainOptions<C> = {
    budget?: TurnBudget;
} & ([C] extends [void] ? {
    context?: C;
} : {
    context: C;
});
type OutboxDrainArgs<C> = [C] extends [void] ? [opts?: OutboxDrainOptions<C>] : [opts: OutboxDrainOptions<C>];
type OutboxHandlerArgs<C> = [C] extends [void] ? [] : [context: C];
export interface OutboxDrainResult {
    sent: number;
    retried: number;
    deadLettered: number;
}
export interface OutboxDeadLetter<M> {
    id: string;
    /** Null when the stored payload no longer parses (a poison-parse row). */
    message: M | null;
    dedupeKey: string | null;
    attemptCount: number;
    lastError: string;
}
/** One named outbox on one hosting actor. Cheap accessor, like `timers()`. */
export declare function outbox<M, C = void>(host: TimerHost, ctx: OutboxContext, name: string, policy: OutboxPolicy<M, C>): Outbox<M, C>;
export declare class Outbox<M, C = void> {
    private readonly host;
    private readonly ctx;
    private readonly policy;
    /** The timer reason this outbox arms in the shared map. */
    readonly reason: string;
    private readonly table;
    private schemaReady;
    private draining;
    /** Largest id ever seen, so a replacement instance mints above it. */
    private lastId;
    private seq;
    constructor(host: TimerHost, ctx: OutboxContext, name: string, policy: OutboxPolicy<M, C>);
    private ensureSchema;
    /**
     * Ids order the drain, so they must grow: time-prefixed, tie-broken by a
     * per-instance counter, and forced above the largest stored id so a
     * replacement instance with a lagging clock cannot mint into the past.
     */
    private mintId;
    /**
     * Write the intent ahead of any send. Returns `admitted: false` with the
     * existing id when the dedupe key is already queued, sent, or dead-lettered
     * — a sent key never reaches send again (the email outbox's short-circuit).
     *
     * Arms the shared timer at `now`, so delivery is owed by the alarm even
     * when the caller never drains inline.
     */
    queue(message: M, opts?: {
        dedupeKey?: string;
        now?: number;
    }): Promise<{
        id: string;
        admitted: boolean;
    }>;
    /** The single-alarm fold: the earliest pending deadline, or null. */
    nextRetryAt(): number | null;
    /** Dead-lettered rows, for inspection. Terminal: nothing retries out. */
    dlq(): Array<OutboxDeadLetter<M>>;
    /**
     * Deliver every due pending row, in id order, honouring per-key blocking.
     * Reentrancy-guarded: the alarm and an inline post-queue drain overlap on
     * the same activation (peer.ts:452 carries the same guard).
     *
     * `budget` bounds the turn: the drain spends each processed row's payload
     * size and suspends when a chunk is full, so a large backlog crosses turns
     * instead of holding the actor's only thread.
     *
     * `context` is handed to every `send` this drain makes — the seam for
     * per-call state such as a transport binding resolved by the caller.
     */
    drain(now?: number, ...rest: OutboxDrainArgs<C>): Promise<OutboxDrainResult>;
    private deadLetter;
    /**
     * The dispatch-side entry for the embedder's timer handler map. Re-arms
     * through the RETURN value: the dispatcher runs handlers inside the chain
     * that serializes the reason map, so a schedule() call from here would
     * deadlock on its own chain.
     *
     * An alarm fires with no caller, so a policy that declares a drain context
     * receives it here once, closed over every alarm-driven drain.
     */
    handler(...context: OutboxHandlerArgs<C>): (now: number) => Promise<TimerHandlerResult>;
}
export {};
//# sourceMappingURL=outbox.d.ts.map