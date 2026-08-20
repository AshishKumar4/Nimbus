/**
 * journal.ts — an append-only event journal with dedupe and delivery leases,
 * over a Durable Object's own SQLite.
 *
 * Modeled on Proteus's EventLog (`core/src/events/hub/log.ts`), which proved
 * the contract this keeps:
 *
 *   - `publish` returns `{ id, admitted }` — a dedupe hit returns the
 *     EXISTING id with `admitted: false` (log.ts:53-58), and the dedupe is
 *     storage-level: a unique partial index over non-null keys, because its
 *     schema comment calls the indexes "mandatory — without them recovery
 *     scans regress to table-scans on the hot path" (hub/schema.ts:6-7).
 *   - pending reads are priority-ordered: higher priority first, arrival
 *     order within a priority.
 *
 * Where this deliberately differs: Proteus binds a delivery by writing
 * `consumed_at` and then needs a cold-start sweep (`unbindStale`, 10 minutes,
 * orchestrator.ts:196) to recover rows a dead activation left bound. Here a
 * claim takes a LEASE that expires on its own — expiry alone re-pends the
 * row, so recovery needs no sweep and no cold-start hook. A lease that
 * expired and was re-claimed is fenced by a per-claim nonce: the dead
 * holder's `done`/`defer`/`dismiss` returns false instead of clobbering the
 * new claimant.
 *
 * Everything here is synchronous — DO SQLite is — so the journal is safe to
 * touch from a constructor without awaiting on the init gate.
 *
 * The index set is derived from this module's own query set, not copied from
 * the consumer's nine: the claim scan gets a partial index over pending rows
 * in claim order, and the dedupe probe gets the unique partial index. No
 * other query here repeats on a hot path.
 */
/** Synchronous DO SQLite, as the journal uses it. */
export interface JournalSqlExec {
    exec(query: string, ...bindings: Array<string | number | null>): Iterable<unknown>;
}
export interface JournalContext {
    storage: {
        sql: JournalSqlExec;
    };
}
export interface JournalPublishResult {
    /** The event id — the existing one when the publish was a duplicate. */
    id: string;
    /** False when the dedupe key already existed; nothing was written. */
    admitted: boolean;
}
/** One claimed delivery: the record, and the lease that settles it. */
export interface JournalClaim<P> {
    id: string;
    payload: P;
    priority: number;
    receivedAt: number;
    lease: JournalLease;
}
/**
 * One delivery lease. Every settle returns whether THIS lease still held the
 * row — false means the lease expired and another claim owns it now, and
 * nothing was written.
 */
export interface JournalLease {
    /** The event is handled; it never delivers again. */
    done(): boolean;
    /** Release the lease and hide the event until `at`. */
    defer(at: number): boolean;
    /** The event is refused for good; it never delivers again. */
    dismiss(reason: string): boolean;
}
/** One named journal on one hosting actor. Cheap accessor, like `timers()`. */
export declare function journal<P>(ctx: JournalContext, name: string): Journal<P>;
export declare class Journal<P> {
    private readonly ctx;
    private readonly table;
    private schemaReady;
    private lastId;
    private seq;
    private leaseSeq;
    constructor(ctx: JournalContext, name: string);
    private ensureSchema;
    /** Same shape as the outbox's: time-ordered, forced above every stored id. */
    private mintId;
    /**
     * Append one event. A dedupe key that already exists — pending, done, or
     * dismissed — refuses the append and names the existing id.
     */
    publish(payload: P, opts?: {
        dedupeKey?: string;
        priority?: number;
        now?: number;
    }): JournalPublishResult;
    /**
     * Claim deliverable events under a lease: pending, at or past their
     * revisit time, and not held by a live lease. Higher priority first,
     * arrival order within a priority. Expiry alone re-pends a row a dead
     * holder left leased — that is the whole recovery path.
     */
    claim(opts: {
        leaseMs: number;
        minPriority?: number;
        limit?: number;
        now?: number;
    }): Array<JournalClaim<P>>;
    /**
     * The settle ops all share one fence: they write only while the row is
     * still pending under THIS lease's nonce. An expired-and-reclaimed row has
     * a different nonce, so the dead holder's settle is a refused no-op —
     * synchronous SQL makes the check-then-write atomic on the actor thread.
     */
    private lease;
}
//# sourceMappingURL=journal.d.ts.map