/**
 * The resident store's tables in the facet's key-value storage, written so
 * the output gate never holds what the process says next.
 *
 * A Durable Object turn that writes SQL holds its next outbound message until
 * the write is confirmed: 23-36 ms measured on every turn a fill wrote rows
 * (verify/consolidation/file-engine-d4-measurements.md). A put with
 * `allowUnconfirmed` holds nothing, and the synchronous `kv.get` and
 * `kv.list` read it at once, in the same turn. Both survive what SQL does: an
 * isolate killed for memory keeps them, one killed for CPU loses the stretch
 * it died in. So the rows are SQLite's (the same database, its __cf_kv
 * table), written without the gate, and read synchronously.
 *
 * Its answers are the tables' (tables.ts ResidentTables), in their key order:
 * keys are the rows' primary keys under one tag each, compared by UTF-8
 * bytes, with numbers zero-padded so their order is numeric; the one-shot's
 * heap answers alike (resident-store-backings). A value that is listed in a
 * scan (a chunk's, a page's) has a key-only index beside it, so a scan never
 * reads the bytes.
 */
import { type ResidentTables, type RowsChanged } from './tables.js';
/** What the store uses of a SQLite-backed Durable Object's storage (ctx.storage). */
export interface ResidentKv {
    readonly kv: {
        get(key: string): unknown;
        list(options?: {
            start?: string;
            end?: string;
            prefix?: string;
            reverse?: boolean;
            limit?: number;
        }): Iterable<[string, unknown]>;
    };
    put(key: string, value: unknown, options: {
        allowUnconfirmed: boolean;
    }): unknown;
    delete(keys: string | string[], options: {
        allowUnconfirmed: boolean;
    }): unknown;
    /** The facet's SQL, the same database: its size is the store's (bytes()); an earlier Nimbus's store tables are dropped from it (store.bind). */
    readonly sql?: {
        readonly databaseSize?: number;
        exec?(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
    };
}
export declare function kvTables(storage: ResidentKv, rowsChanged?: RowsChanged): ResidentTables;
//# sourceMappingURL=kv-tables.d.ts.map