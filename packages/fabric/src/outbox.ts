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

import { z } from 'zod/v4';
import { timers, type TimerContext, type TimerHandlerResult, type TimerHost, type TimerStorage } from './timers.js';
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
export type OutboxDisposition =
  | { status: 'sent' }
  | { status: 'retry'; reason: string }
  | { status: 'poison'; reason: string };

export interface OutboxPolicy<M> {
  /** Attempts before a row dead-letters. Email uses 8; peer uses 8. */
  maxAttempts: number;
  /** Backoff base: `next = now + baseMs * 2**(attempts-1)`. */
  baseMs: number;
  /**
   * Per-key delivery order (the peer transport's per-receiver key). Rows
   * without a key deliver independently, as the email outbox's do.
   */
  orderBy?(message: M): string;
  /** Deliver one message. Throwing is transient, same as `retry`. */
  send(message: M, info: { id: string; attempt: number }): Promise<OutboxDisposition>;
}

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

const PendingRowSchema = z.object({
  id: z.string(),
  message: z.string(),
  order_key: z.string().nullable(),
  attempt_count: z.number(),
  next_attempt_at: z.number(),
});

const DlqRowSchema = z.object({
  id: z.string(),
  message: z.string(),
  dedupe_key: z.string().nullable(),
  attempt_count: z.number(),
  last_error: z.string().nullable(),
});

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;

/** One named outbox on one hosting actor. Cheap accessor, like `timers()`. */
export function outbox<M>(
  host: TimerHost,
  ctx: OutboxContext,
  name: string,
  policy: OutboxPolicy<M>,
): Outbox<M> {
  return new Outbox(host, ctx, name, policy);
}

export class Outbox<M> {
  /** The timer reason this outbox arms in the shared map. */
  readonly reason: string;

  private readonly table: string;
  private schemaReady = false;
  private draining = false;
  /** Largest id ever seen, so a replacement instance mints above it. */
  private lastId = '';
  private seq = 0;

  constructor(
    private readonly host: TimerHost,
    private readonly ctx: OutboxContext,
    name: string,
    private readonly policy: OutboxPolicy<M>,
  ) {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`fabric: outbox name '${name}' must match ${NAME_PATTERN}`);
    }
    this.table = `outbox_${name}`;
    this.reason = `outbox:${name}`;
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (
      id              TEXT    PRIMARY KEY,
      dedupe_key      TEXT,
      order_key       TEXT,
      message         TEXT    NOT NULL,
      state           TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (state IN ('pending', 'sent', 'dlq')),
      attempt_count   INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      sent_at         INTEGER,
      last_error      TEXT
    )`);
    sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${this.table}_dedupe
      ON ${this.table} (dedupe_key) WHERE dedupe_key IS NOT NULL`);
    // The recovery read (`nextRetryAt`, the drain) must not table-scan sent
    // history, which only grows — the same reason both consumer schemas carry
    // exactly this partial index.
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_${this.table}_pending
      ON ${this.table} (next_attempt_at) WHERE state = 'pending'`);
    const rows = [...sql.exec(`SELECT MAX(id) AS id FROM ${this.table}`)] as Array<{ id: string | null }>;
    this.lastId = rows[0]?.id ?? '';
    this.schemaReady = true;
  }

  /**
   * Ids order the drain, so they must grow: time-prefixed, tie-broken by a
   * per-instance counter, and forced above the largest stored id so a
   * replacement instance with a lagging clock cannot mint into the past.
   */
  private mintId(now: number): string {
    let id = `${now.toString(36).padStart(9, '0')}-${(this.seq++).toString(36).padStart(6, '0')}`;
    if (this.lastId !== '' && id <= this.lastId) id = `${this.lastId}0`;
    this.lastId = id;
    return id;
  }

  /**
   * Write the intent ahead of any send. Returns `admitted: false` with the
   * existing id when the dedupe key is already queued, sent, or dead-lettered
   * — a sent key never reaches send again (the email outbox's short-circuit).
   *
   * Arms the shared timer at `now`, so delivery is owed by the alarm even
   * when the caller never drains inline.
   */
  async queue(message: M, opts: { dedupeKey?: string; now?: number } = {}): Promise<{ id: string; admitted: boolean }> {
    this.ensureSchema();
    const now = opts.now ?? Date.now();
    const sql = this.ctx.storage.sql;
    if (opts.dedupeKey !== undefined) {
      const existing = [...sql.exec(
        `SELECT id FROM ${this.table} WHERE dedupe_key = ?`, opts.dedupeKey,
      )] as Array<{ id: string }>;
      if (existing.length > 0) return { id: existing[0].id, admitted: false };
    }
    const id = this.mintId(now);
    sql.exec(
      `INSERT INTO ${this.table} (id, dedupe_key, order_key, message, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      opts.dedupeKey ?? null,
      this.policy.orderBy?.(message) ?? null,
      JSON.stringify(message),
      now,
      now,
    );
    await timers(this.host, this.ctx).schedule(this.reason, now);
    return { id, admitted: true };
  }

  /** The single-alarm fold: the earliest pending deadline, or null. */
  nextRetryAt(): number | null {
    this.ensureSchema();
    const rows = [...this.ctx.storage.sql.exec(
      `SELECT MIN(next_attempt_at) AS next FROM ${this.table} WHERE state = 'pending'`,
    )] as Array<{ next: number | null }>;
    return rows[0]?.next ?? null;
  }

  /** Dead-lettered rows, for inspection. Terminal: nothing retries out. */
  dlq(): Array<OutboxDeadLetter<M>> {
    this.ensureSchema();
    const rows = [...this.ctx.storage.sql.exec(
      `SELECT id, message, dedupe_key, attempt_count, last_error FROM ${this.table} WHERE state = 'dlq' ORDER BY id`,
    )].map((row) => DlqRowSchema.parse(row));
    return rows.map((row) => {
      let message: M | null = null;
      try { message = JSON.parse(row.message) as M; } catch { /* poison-parse row */ }
      return {
        id: row.id,
        message,
        dedupeKey: row.dedupe_key,
        attemptCount: row.attempt_count,
        lastError: row.last_error ?? '',
      };
    });
  }

  /**
   * Deliver every due pending row, in id order, honouring per-key blocking.
   * Reentrancy-guarded: the alarm and an inline post-queue drain overlap on
   * the same activation (peer.ts:452 carries the same guard).
   *
   * `budget` bounds the turn: the drain spends each processed row's payload
   * size and suspends when a chunk is full, so a large backlog crosses turns
   * instead of holding the actor's only thread.
   */
  async drain(now = Date.now(), opts: { budget?: TurnBudget } = {}): Promise<OutboxDrainResult> {
    const result: OutboxDrainResult = { sent: 0, retried: 0, deadLettered: 0 };
    if (this.draining) return result;
    this.draining = true;
    try {
      this.ensureSchema();
      const sql = this.ctx.storage.sql;
      const rows = [...sql.exec(
        `SELECT id, message, order_key, attempt_count, next_attempt_at
         FROM ${this.table} WHERE state = 'pending' ORDER BY id`,
      )].map((row) => PendingRowSchema.parse(row));
      const blocked = new Set<string>();
      for (const row of rows) {
        if (row.order_key !== null && blocked.has(row.order_key)) continue;
        if (row.next_attempt_at > now) {
          // A backed-off head still blocks the rows queued behind it.
          if (row.order_key !== null) blocked.add(row.order_key);
          continue;
        }
        let message: M;
        try {
          message = JSON.parse(row.message) as M;
        } catch (e) {
          // Unparseable is poison: it can never succeed, so it never blocks.
          this.deadLetter(row.id, row.attempt_count, `outbox row does not parse: ${errorText(e)}`);
          result.deadLettered++;
          continue;
        }
        const attempt = row.attempt_count + 1;
        let disposition: OutboxDisposition;
        try {
          disposition = await this.policy.send(message, { id: row.id, attempt });
        } catch (e) {
          disposition = { status: 'retry', reason: errorText(e) };
        }
        if (disposition.status === 'sent') {
          sql.exec(
            `UPDATE ${this.table} SET state = 'sent', attempt_count = ?, sent_at = ?, last_error = NULL WHERE id = ?`,
            attempt, now, row.id,
          );
          result.sent++;
        } else if (disposition.status === 'poison') {
          this.deadLetter(row.id, attempt, disposition.reason);
          result.deadLettered++;
        } else if (attempt >= this.policy.maxAttempts) {
          this.deadLetter(row.id, attempt, `undeliverable after ${attempt} attempts: ${disposition.reason}`);
          result.deadLettered++;
        } else {
          const next = now + this.policy.baseMs * 2 ** (attempt - 1);
          sql.exec(
            `UPDATE ${this.table} SET attempt_count = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`,
            attempt, next, disposition.reason, row.id,
          );
          result.retried++;
          if (row.order_key !== null) blocked.add(row.order_key);
        }
        // Code-unit length: equal to UTF-8 bytes for the ASCII JSON the rows
        // hold, an undercount otherwise — the bound names where a turn ends,
        // it is not an admission ceiling (same reading as budgets.ts).
        await opts.budget?.spend(row.message.length);
      }
      return result;
    } finally {
      this.draining = false;
    }
  }

  private deadLetter(id: string, attempts: number, error: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE ${this.table} SET state = 'dlq', attempt_count = ?, last_error = ? WHERE id = ?`,
      attempts, error, id,
    );
  }

  /**
   * The dispatch-side entry for the embedder's timer handler map. Re-arms
   * through the RETURN value: the dispatcher runs handlers inside the chain
   * that serializes the reason map, so a schedule() call from here would
   * deadlock on its own chain.
   */
  handler(): (now: number) => Promise<TimerHandlerResult> {
    return async (now: number) => {
      await this.drain(now);
      const next = this.nextRetryAt();
      return next === null ? undefined : { rearmAt: next };
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
