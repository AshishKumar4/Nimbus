/**
 * d1-database.ts — one D1 binding's database under `wrangler dev`: a
 * Durable Object facet of the session, whose SQLite is its own. The session's
 * tables (its filesystem, its ledgers) are in the session's database, which
 * a facet cannot reach, so no statement a user's migrations or Worker sends
 * can read or change them; a statement naming one finds no such table, as
 * it would on a fresh D1 database.
 *
 * The D1 API a Worker is given (bindings/d1.ts) prepares statements and
 * sends them here to run.
 */
import { DurableObject } from 'cloudflare:workers';
/** wrangler's own migrations ledger, as `wrangler d1 migrations apply` keeps it. */
const LEDGER = 'd1_migrations';
export class NimbusD1Database extends DurableObject {
    /**
     * Run `statements` in order. With `atomic` (a batch), all of them or none:
     * the first failure rolls the rest back and is thrown. Otherwise each
     * answers its own result, a failure included.
     */
    query(statements, atomic) {
        if (!atomic)
            return statements.map((statement) => this.#run(statement));
        return this.ctx.storage.transactionSync(() => statements.map((statement) => {
            const result = this.#run(statement);
            if (!result.success)
                throw new Error(result.error ?? 'batch failed');
            return result;
        }));
    }
    /** Each of `query`'s statements, in order, until one fails (it throws). */
    exec(query) {
        const t0 = Date.now();
        let count = 0;
        for (const statement of splitStatements(query)) {
            if (!statement.trim())
                continue;
            this.ctx.storage.sql.exec(statement);
            count++;
        }
        return { count, duration: Date.now() - t0 };
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
                            sql.exec(statement);
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
    #run({ sql, params }) {
        const t0 = Date.now();
        try {
            const cursor = this.ctx.storage.sql.exec(sql, ...params);
            const results = cursor.toArray();
            return { success: true, results, meta: meta(cursor.rowsRead, cursor.rowsWritten, t0) };
        }
        catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error), meta: meta(0, 0, t0) };
        }
    }
}
function meta(rowsRead, rowsWritten, t0) {
    return {
        duration: Date.now() - t0,
        changes: rowsWritten,
        last_row_id: 0,
        rows_read: rowsRead,
        rows_written: rowsWritten,
        served_by: 'nimbus-d1-emu',
        changed_db: rowsWritten > 0,
    };
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
