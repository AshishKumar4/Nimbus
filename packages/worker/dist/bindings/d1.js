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
/**
 * The facet a project's database is: `d1:` and the project root and the
 * database, each whole (a name made of either cannot be another's).
 */
export function d1DatabaseFacetName(root, database) {
    return 'd1:' + JSON.stringify([root, database]);
}
// ── D1 prepared statement ────────────────────────────────────────────────
/** What a batch sends of a statement: off the statement's own surface. */
let statementOf;
export class D1PreparedStatementEmu {
    #emu;
    #statement;
    static {
        statementOf = (statement) => statement.#statement;
    }
    constructor(emu, statement) {
        this.#emu = emu;
        this.#statement = statement;
    }
    bind(...values) {
        return new D1PreparedStatementEmu(this.#emu, { sql: this.#statement.sql, params: values });
    }
    async first(colName) {
        const r = await this.all();
        const row = r.results && r.results[0];
        if (!row)
            return null;
        if (colName !== undefined)
            return row[colName] ?? null;
        return row;
    }
    run() {
        return this.all();
    }
    async all() {
        const [result] = await this.#emu.database().query([this.#statement], false);
        return result;
    }
    async raw() {
        const r = await this.all();
        return (r.results || []).map((row) => Object.values(row));
    }
}
// ── D1Emulator ────────────────────────────────────────────────────────────
export class D1Emulator {
    database;
    #migrationsRun = false;
    #binding;
    #migrationsDir;
    #vfs;
    #root;
    #onLog;
    constructor(opts) {
        this.database = opts.database;
        this.#binding = opts.binding;
        this.#migrationsDir = opts.migrationsDir;
        this.#vfs = opts.vfs;
        this.#root = opts.root;
        this.#onLog = opts.onLog || (() => { });
    }
    prepare(query) {
        return new D1PreparedStatementEmu(this, { sql: query, params: [] });
    }
    /** All of `stmts` or none: the first failure rolls the batch back and is thrown. */
    batch(stmts) {
        return this.database().query(stmts.map(statementOf), true);
    }
    exec(query) {
        return this.database().exec(query);
    }
    /**
     * Apply the migrations in migrations_dir the database has not, in name
     * order, each one whole or not at all; the first that fails is logged and
     * ends the run. Once per emulator.
     */
    async applyMigrations() {
        if (this.#migrationsRun || !this.#migrationsDir || !this.#vfs)
            return { applied: 0 };
        this.#migrationsRun = true;
        const root = (this.#root || '').replace(/^\/+/, '').replace(/\/+$/, '');
        const dir = this.#migrationsDir.replace(/^\/+/, '').replace(/\/+$/, '');
        const fullDir = root ? root + '/' + dir : dir;
        if (!this.#vfs.exists(fullDir))
            return { applied: 0 };
        const vfs = this.#vfs;
        const migrations = vfs.readdir(fullDir)
            .filter((e) => e.type === 'file' && e.name.endsWith('.sql'))
            .map((e) => e.name)
            .sort()
            .map((name) => ({ name, sql: vfs.readFileString(fullDir + '/' + name) }));
        const outcome = await this.database().applyMigrations(migrations);
        if (outcome.failed) {
            this.#onLog(`  \x1b[33mwarning: D1 ${this.#binding}: migration ${outcome.failed.name} failed and was rolled back: ${outcome.failed.error}\x1b[0m\n`);
        }
        return { applied: outcome.applied.length };
    }
}
