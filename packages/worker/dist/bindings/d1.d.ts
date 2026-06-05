/**
 * binding-d1.ts — D1 database emulator for nimbus-wrangler.
 *
 * Implements the Workers D1 runtime API
 * (https://developers.cloudflare.com/d1/worker-api/) backed by the
 * supervisor's own SqlStorage. Tables are namespaced per-binding via a
 * lightweight identifier-rewriter so two D1 bindings on the same
 * SqlStorage don't collide.
 *
 * Plan §14.1 (post-review amendment) recommends a child-DO-facet-per-
 * binding architecture for full isolation in production. Implementation
 * cost: a new DO class registered in src/index.ts + a wrangler.jsonc
 * migration entry. Deferred to W10.5 — for W10 we ship the simpler
 * single-storage variant with prefix-rewriting. Test seam preserves
 * the contract so the upgrade is a drop-in replacement.
 *
 * Rewriter scope (deliberately narrow):
 *   - CREATE [TABLE|INDEX|TRIGGER|VIEW] <name>      → prefixed
 *   - DROP TABLE <name>                              → prefixed
 *   - INSERT [OR ...] INTO <name>                    → prefixed
 *   - SELECT ... FROM <name> [, <name>] ... [JOIN <name>] ...  → prefixed
 *   - UPDATE <name>                                  → prefixed
 *   - DELETE FROM <name>                             → prefixed
 *   - WITH <cte> AS (SELECT ...)                     → CTE alias is NOT
 *     prefixed (it's a query-local alias, not a real table); the inner
 *     FROM <table> IS prefixed if it matches a known table
 *
 * SQL keywords are matched case-insensitively. We DO NOT rewrite inside
 * string literals (single-quoted) or quoted identifiers in
 * CREATE/INSERT/etc — the rewriter walks tokens, not bytes.
 *
 * Bind parameter forms: '?' positional only. Named parameters (':name')
 * are NOT supported (D1 itself doesn't support them).
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
export interface D1Result<T = Record<string, any>> {
    success: boolean;
    results?: T[];
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
export interface D1EmulatorOptions {
    /** workerd SqlStorage instance, e.g. ctx.storage.sql. */
    sqlStorage: any;
    binding: string;
    vfs?: SqliteVFS | any;
    root?: string;
    migrationsDir?: string;
    onLog?: (msg: string) => void;
}
export declare class D1PreparedStatementEmu {
    /** @internal */
    _sql: string;
    /** @internal */
    _params: any[];
    private _emu;
    constructor(emu: D1Emulator, sql: string, params: any[]);
    bind(...values: any[]): D1PreparedStatementEmu;
    first<T = any>(colName?: string): Promise<T | null>;
    run<T = any>(): Promise<D1Result<T>>;
    all<T = any>(): Promise<D1Result<T>>;
    raw<T = any>(): Promise<T[]>;
}
export declare class D1Emulator {
    private sql;
    private prefix;
    private prefixer;
    private migrationsRun;
    private migrationsDir?;
    private vfs?;
    private root?;
    private onLog;
    constructor(opts: D1EmulatorOptions);
    prepare(query: string): D1PreparedStatementEmu;
    batch<T = any>(stmts: D1PreparedStatementEmu[]): Promise<D1Result<T>[]>;
    exec(query: string): Promise<D1ExecResult>;
    /** @internal */
    _runOne(sql: string, params: any[]): D1Result<any>;
    /** Synchronous core (workerd SqlStorage.exec is sync). */
    /** @internal */
    _runOneSync(sql: string, params: any[]): D1Result<any>;
    private _meta;
    /** Apply migrations from migrations_dir if present. Idempotent. */
    applyMigrations(): Promise<{
        applied: number;
    }>;
}
//# sourceMappingURL=d1.d.ts.map