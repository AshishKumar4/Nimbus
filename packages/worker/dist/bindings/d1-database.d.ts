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
import type { D1ExecResult, D1Result, SqlValue } from './d1.js';
/** A prepared statement as it is sent to run: its text and its bound values. */
export interface D1Statement {
    sql: string;
    params: SqlValue[];
}
/** One migration file: its name (the ledger's key) and its statements. */
export interface D1Migration {
    name: string;
    sql: string;
}
/**
 * What applying migrations did: the ones applied, in order, and the one that
 * failed (rolled back, unrecorded), after which none was tried.
 */
export interface D1MigrationOutcome {
    applied: string[];
    failed?: {
        name: string;
        error: string;
    };
}
export declare class NimbusD1Database extends DurableObject {
    #private;
    /**
     * Run `statements` in order. With `atomic` (a batch), all of them or none:
     * the first failure rolls the rest back and is thrown. Otherwise each
     * answers its own result, a failure included.
     */
    query(statements: readonly D1Statement[], atomic: boolean): D1Result[];
    /** Each of `query`'s statements, in order, until one fails (it throws). */
    exec(query: string): D1ExecResult;
    /**
     * Apply each of `migrations` not in the ledger, in order, as `wrangler d1
     * migrations apply` does: each one whole, and recorded, or not at all; the
     * first that fails is rolled back and ends the run.
     */
    applyMigrations(migrations: readonly D1Migration[]): D1MigrationOutcome;
}
/**
 * `sql` split on `;` outside string literals, a trigger's BEGIN … END kept
 * whole.
 */
export declare function splitStatements(sql: string): string[];
//# sourceMappingURL=d1-database.d.ts.map