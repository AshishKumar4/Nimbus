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
import type { D1QueryResponse, D1QuerySql } from '@nimbus-sh/fabric/inner-storage-env.js';
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
     * D1's binding contract: every query of a request, in order, in one
     * transaction, each answered as its columns and rows, and the database's
     * bookmark after them; or, when one fails, none applied and the failure.
     * A query that is only blanks and comments is dropped, and a request left
     * with none fails. There is one copy of the database, so any bookmark a
     * session holds is already met, and none is waited for.
     */
    query(queries: readonly D1QuerySql[]): Promise<D1QueryResponse>;
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