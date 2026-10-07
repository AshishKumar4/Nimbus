/**
 * table-ids.ts — the names and row ids of fabric's durable tables (the
 * journal's and the outbox's). Each keeps its own schema and queries.
 */
import { z } from 'zod/v4';
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;
const MaxIdRowSchema = z.object({ id: z.string().nullable() });
/** The SQL table a `kind` named `name` lives in; refuses a name that is not a safe identifier. */
export function fabricTableName(kind, name) {
    if (!NAME_PATTERN.test(name)) {
        throw new Error(`fabric: ${kind} name '${name}' must match ${NAME_PATTERN}`);
    }
    return `${kind}_${name}`;
}
/**
 * Row ids that order a table: time-prefixed, tie-broken by a per-instance
 * counter, and forced above the largest stored id, so a replacement instance
 * with a lagging clock cannot mint into the past.
 */
export class TableIds {
    /** Largest id ever seen, stored or minted. */
    last = '';
    seq = 0;
    /** Adopt the largest id `table` already stores. */
    adopt(sql, table) {
        const [row] = [...sql.exec(`SELECT MAX(id) AS id FROM ${table}`)];
        this.last = row === undefined ? '' : MaxIdRowSchema.parse(row).id ?? '';
    }
    mint(now) {
        let id = `${now.toString(36).padStart(9, '0')}-${(this.seq++).toString(36).padStart(6, '0')}`;
        if (this.last !== '' && id <= this.last)
            id = `${this.last}0`;
        this.last = id;
        return id;
    }
}
