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
import { z } from 'zod/v4';
const ClaimRowSchema = z.object({
    id: z.string(),
    payload: z.string(),
    priority: z.number(),
    received_at: z.number(),
});
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;
/** One named journal on one hosting actor. Cheap accessor, like `timers()`. */
export function journal(ctx, name) {
    return new Journal(ctx, name);
}
export class Journal {
    ctx;
    table;
    schemaReady = false;
    lastId = '';
    seq = 0;
    leaseSeq = 0;
    constructor(ctx, name) {
        this.ctx = ctx;
        if (!NAME_PATTERN.test(name)) {
            throw new Error(`fabric: journal name '${name}' must match ${NAME_PATTERN}`);
        }
        this.table = `journal_${name}`;
    }
    ensureSchema() {
        if (this.schemaReady)
            return;
        const sql = this.ctx.storage.sql;
        sql.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (
      id             TEXT    PRIMARY KEY,
      payload        TEXT    NOT NULL,
      dedupe_key     TEXT,
      priority       INTEGER NOT NULL DEFAULT 0,
      state          TEXT    NOT NULL DEFAULT 'pending'
                             CHECK (state IN ('pending', 'done', 'dismissed')),
      received_at    INTEGER NOT NULL,
      not_before     INTEGER NOT NULL DEFAULT 0,
      lease_id       TEXT,
      lease_until    INTEGER,
      done_at        INTEGER,
      dismiss_reason TEXT
    )`);
        sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${this.table}_dedupe
      ON ${this.table} (dedupe_key) WHERE dedupe_key IS NOT NULL`);
        // The claim scan in its own order, over pending rows only — done history
        // grows without bound and must never be what recovery reads through.
        sql.exec(`CREATE INDEX IF NOT EXISTS idx_${this.table}_pending
      ON ${this.table} (priority DESC, id) WHERE state = 'pending'`);
        const rows = [...sql.exec(`SELECT MAX(id) AS id FROM ${this.table}`)];
        this.lastId = rows[0]?.id ?? '';
        this.schemaReady = true;
    }
    /** Same shape as the outbox's: time-ordered, forced above every stored id. */
    mintId(now) {
        let id = `${now.toString(36).padStart(9, '0')}-${(this.seq++).toString(36).padStart(6, '0')}`;
        if (this.lastId !== '' && id <= this.lastId)
            id = `${this.lastId}0`;
        this.lastId = id;
        return id;
    }
    /**
     * Append one event. A dedupe key that already exists — pending, done, or
     * dismissed — refuses the append and names the existing id.
     */
    publish(payload, opts = {}) {
        this.ensureSchema();
        const now = opts.now ?? Date.now();
        const sql = this.ctx.storage.sql;
        if (opts.dedupeKey !== undefined) {
            const existing = [...sql.exec(`SELECT id FROM ${this.table} WHERE dedupe_key = ?`, opts.dedupeKey)];
            if (existing.length > 0)
                return { id: existing[0].id, admitted: false };
        }
        const id = this.mintId(now);
        sql.exec(`INSERT INTO ${this.table} (id, payload, dedupe_key, priority, received_at, not_before)
       VALUES (?, ?, ?, ?, ?, 0)`, id, JSON.stringify(payload), opts.dedupeKey ?? null, opts.priority ?? 0, now);
        return { id, admitted: true };
    }
    /**
     * Claim deliverable events under a lease: pending, at or past their
     * revisit time, and not held by a live lease. Higher priority first,
     * arrival order within a priority. Expiry alone re-pends a row a dead
     * holder left leased — that is the whole recovery path.
     */
    claim(opts) {
        this.ensureSchema();
        const now = opts.now ?? Date.now();
        const sql = this.ctx.storage.sql;
        const rows = [...sql.exec(`SELECT id, payload, priority, received_at FROM ${this.table}
       WHERE state = 'pending'
         AND priority >= ?
         AND not_before <= ?
         AND (lease_until IS NULL OR lease_until <= ?)
       ORDER BY priority DESC, id
       LIMIT ?`, opts.minPriority ?? -2147483648, now, now, opts.limit ?? 50)].map((row) => ClaimRowSchema.parse(row));
        const claims = [];
        for (const row of rows) {
            const leaseId = `${now.toString(36)}-${(this.leaseSeq++).toString(36)}`;
            sql.exec(`UPDATE ${this.table} SET lease_id = ?, lease_until = ? WHERE id = ?`, leaseId, now + opts.leaseMs, row.id);
            claims.push({
                id: row.id,
                payload: JSON.parse(row.payload),
                priority: row.priority,
                receivedAt: row.received_at,
                lease: this.lease(row.id, leaseId),
            });
        }
        return claims;
    }
    /**
     * The settle ops all share one fence: they write only while the row is
     * still pending under THIS lease's nonce. An expired-and-reclaimed row has
     * a different nonce, so the dead holder's settle is a refused no-op —
     * synchronous SQL makes the check-then-write atomic on the actor thread.
     */
    lease(id, leaseId) {
        const sql = this.ctx.storage.sql;
        const holds = () => {
            const rows = [...sql.exec(`SELECT 1 AS held FROM ${this.table} WHERE id = ? AND state = 'pending' AND lease_id = ?`, id, leaseId)];
            return rows.length > 0;
        };
        return {
            done: () => {
                if (!holds())
                    return false;
                sql.exec(`UPDATE ${this.table} SET state = 'done', done_at = ?, lease_id = NULL, lease_until = NULL WHERE id = ?`, Date.now(), id);
                return true;
            },
            defer: (at) => {
                if (!holds())
                    return false;
                sql.exec(`UPDATE ${this.table} SET not_before = ?, lease_id = NULL, lease_until = NULL WHERE id = ?`, at, id);
                return true;
            },
            dismiss: (reason) => {
                if (!holds())
                    return false;
                sql.exec(`UPDATE ${this.table} SET state = 'dismissed', dismiss_reason = ?, lease_id = NULL, lease_until = NULL WHERE id = ?`, reason, id);
                return true;
            },
        };
    }
}
