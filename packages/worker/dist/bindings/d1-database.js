/**
 * d1-database.ts — one D1 binding's database under `wrangler dev`: a
 * Durable Object facet of the session, whose SQLite is its own. The session's
 * tables (its filesystem, its ledgers) are in the session's database, which
 * a facet cannot reach, so no statement a user's migrations or Worker sends
 * can read or change them; a statement naming one finds no such table, as
 * it would on a fresh D1 database.
 *
 * The Worker's D1 API (fabric inner-storage-env.ts) prepares statements and
 * sends them here, through the session (session/rpc.ts _rpcD1Query), by D1's
 * binding contract; each request runs as Cloudflare's local D1 database
 * (Miniflare's) runs it.
 */
import { DurableObject } from 'cloudflare:workers';
/** wrangler's own migrations ledger, as `wrangler d1 migrations apply` keeps it. */
const LEDGER = 'd1_migrations';
/** Who ran a statement, in its meta. */
const SERVED_BY = 'nimbus-d1-emu';
export class NimbusD1Database extends DurableObject {
    /**
     * D1's binding contract: every query of a request, in order, in one
     * transaction, each answered as its columns and rows, and the database's
     * bookmark after them; or, when one fails, none applied and the failure.
     * A query that is only blanks and comments is dropped, and a request left
     * with none fails. There is one copy of the database, so any bookmark a
     * session holds is already met, and none is waited for.
     */
    async query(queries) {
        const sql = queries.filter((query) => query.sql.replace(/^\s+--.*/gm, '').trim().length > 0);
        if (sql.length === 0)
            return { success: false, error: { name: 'Error', message: 'No SQL statements detected.' } };
        let queryResults;
        try {
            queryResults = this.ctx.storage.transactionSync(() => sql.map((query) => this.#run(query)));
        }
        catch (error) {
            return { success: false, error: { name: 'Error', message: error instanceof Error ? error.message : String(error) } };
        }
        return { success: true, results: { queryResults, bookmark: await this.ctx.storage.getCurrentBookmark() } };
    }
    /**
     * Apply each of `migrations` not in the ledger, in order, as `wrangler d1
     * migrations apply` does: each one whole, and recorded, or not at all; the
     * first that fails is rolled back and ends the run.
     */
    applyMigrations(migrations) {
        const sql = this.ctx.storage.sql;
        sql.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
        const applied = [];
        for (const migration of migrations) {
            if (sql.exec(`SELECT 1 FROM ${LEDGER} WHERE name = ?`, migration.name).toArray().length > 0)
                continue;
            try {
                this.ctx.storage.transactionSync(() => {
                    for (const statement of splitStatements(migration.sql)) {
                        if (statement.trim())
                            runWhole(sql, statement);
                    }
                    sql.exec(`INSERT INTO ${LEDGER} (name) VALUES (?)`, migration.name);
                });
            }
            catch (error) {
                return { applied, failed: { name: migration.name, error: error instanceof Error ? error.message : String(error) } };
            }
            applied.push(migration.name);
        }
        return { applied };
    }
    /**
     * One query run to its last row, a blob given and answered as its bytes,
     * and its meta: the changes it made and the rowid it left, by SQLite's own
     * counters, and the rows it read and wrote.
     */
    #run({ sql: query, params = [] }) {
        const sql = this.ctx.storage.sql;
        const t0 = performance.now();
        const sizeBefore = sql.databaseSize;
        const before = counters(sql);
        const cursor = sql.exec(query, ...params.map((param) => (Array.isArray(param) ? new Uint8Array(param).buffer : param)));
        const columns = cursor.columnNames;
        const rows = Array.from(cursor.raw(), (row) => row.map((cell) => (cell instanceof ArrayBuffer ? Array.from(new Uint8Array(cell)) : cell)));
        const after = counters(sql);
        const changes = after.totalChanges - before.totalChanges;
        return {
            meta: {
                served_by: SERVED_BY,
                duration: performance.now() - t0,
                changes,
                last_row_id: after.lastRowId,
                changed_db: changes !== 0 || after.lastRowId !== before.lastRowId || sql.databaseSize !== sizeBefore,
                size_after: sql.databaseSize,
                rows_read: cursor.rowsRead,
                rows_written: cursor.rowsWritten,
            },
            data: { kind: 'raw', columns, rows },
        };
    }
}
/** SQLite's count of the changes this connection has made, and the rowid it last inserted. */
function counters(sql) {
    return sql.exec('SELECT total_changes() AS totalChanges, last_insert_rowid() AS lastRowId').one();
}
/**
 * `statement` run to its last row: SQLite evaluates a statement's rows as
 * they are read, so one whose later row fails has not failed until it is read.
 */
function runWhole(sql, statement) {
    sql.exec(statement).toArray();
}
/**
 * `sql` split on `;` outside string literals, a trigger's BEGIN … END kept
 * whole.
 */
export function splitStatements(sql) {
    const out = [];
    let cur = '';
    let inStr = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (inStr) {
            cur += ch;
            if (ch === "'") {
                if (sql[i + 1] === "'") {
                    cur += sql[++i];
                    continue;
                }
                inStr = false;
            }
            continue;
        }
        if (ch === "'") {
            inStr = true;
            cur += ch;
            continue;
        }
        if (ch === ';') {
            const upper = cur.toUpperCase();
            const begins = (upper.match(/\bBEGIN\b/g) || []).length;
            const ends = (upper.match(/\bEND\b/g) || []).length;
            if (begins > ends) {
                cur += ch;
                continue;
            }
            out.push(cur);
            cur = '';
            continue;
        }
        cur += ch;
    }
    if (cur.trim())
        out.push(cur);
    return out;
}
