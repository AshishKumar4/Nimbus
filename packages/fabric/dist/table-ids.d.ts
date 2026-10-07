/**
 * table-ids.ts — the names and row ids of fabric's durable tables (the
 * journal's and the outbox's). Each keeps its own schema and queries.
 */
/** The SQL table a `kind` named `name` lives in; refuses a name that is not a safe identifier. */
export declare function fabricTableName(kind: 'journal' | 'outbox', name: string): string;
/**
 * Row ids that order a table: time-prefixed, tie-broken by a per-instance
 * counter, and forced above the largest stored id, so a replacement instance
 * with a lagging clock cannot mint into the past.
 */
export declare class TableIds {
    /** Largest id ever seen, stored or minted. */
    private last;
    private seq;
    /** Adopt the largest id `table` already stores. */
    adopt(sql: {
        exec(query: string): Iterable<unknown>;
    }, table: string): void;
    mint(now: number): string;
}
//# sourceMappingURL=table-ids.d.ts.map