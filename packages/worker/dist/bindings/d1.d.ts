/**
 * d1.ts — the D1 binding nimbus-wrangler gives a Worker under `wrangler
 * dev` (https://developers.cloudflare.com/d1/worker-api/).
 *
 * Statements are prepared here and run in the binding's own database, a
 * Durable Object facet of the session (d1-database.ts): never in the
 * session's database, whose tables no statement can name.
 *
 * Bind parameter forms: '?' positional only. Named parameters (':name')
 * are NOT supported (D1 itself doesn't support them).
 */
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { D1Migration, D1MigrationOutcome, D1Statement } from './d1-database.js';
/** A value SQLite stores, as workerd's SqlStorage gives and takes it. */
export type SqlValue = ArrayBuffer | string | number | null;
export type D1Row = Record<string, SqlValue>;
export interface D1Result {
    success: boolean;
    results?: D1Row[];
    meta: D1Meta;
    error?: string;
}
export interface D1Meta {
    duration: number;
    changes: number;
    last_row_id: number;
    rows_read: number;
    rows_written: number;
    size_after?: number;
    served_by: string;
    changed_db: boolean;
}
export interface D1ExecResult {
    count: number;
    duration: number;
}
/** The binding's database, as its facet's stub answers (d1-database.ts NimbusD1Database). */
export interface D1Database {
    query(statements: readonly D1Statement[], atomic: boolean): Promise<D1Result[]>;
    exec(query: string): Promise<D1ExecResult>;
    applyMigrations(migrations: readonly D1Migration[]): Promise<D1MigrationOutcome>;
}
export interface D1EmulatorOptions {
    /**
     * The binding's database. Called for each use: a facet's stub belongs to
     * the request that got it.
     */
    database: () => D1Database;
    binding: string;
    vfs?: CredentialedVfs;
    root?: string;
    migrationsDir?: string;
    onLog?: (msg: string) => void;
}
export declare class D1PreparedStatementEmu {
    #private;
    constructor(emu: D1Emulator, statement: D1Statement);
    bind(...values: SqlValue[]): D1PreparedStatementEmu;
    first(colName?: string): Promise<D1Row | SqlValue | null>;
    run(): Promise<D1Result>;
    all(): Promise<D1Result>;
    raw(): Promise<SqlValue[][]>;
}
export declare class D1Emulator {
    #private;
    readonly database: () => D1Database;
    constructor(opts: D1EmulatorOptions);
    prepare(query: string): D1PreparedStatementEmu;
    /** All of `stmts` or none: the first failure rolls the batch back and is thrown. */
    batch(stmts: readonly D1PreparedStatementEmu[]): Promise<D1Result[]>;
    exec(query: string): Promise<D1ExecResult>;
    /**
     * Apply the migrations in migrations_dir the database has not, in name
     * order, each one whole or not at all; the first that fails is logged and
     * ends the run. Once per emulator.
     */
    applyMigrations(): Promise<{
        applied: number;
    }>;
}
//# sourceMappingURL=d1.d.ts.map