/**
 * d1.ts — a `wrangler dev` D1 binding's database, from the session's side
 * (https://developers.cloudflare.com/d1/worker-api/).
 *
 * Each binding's database is a Durable Object facet of the session
 * (d1-database.ts), named by its project and database: never the session's
 * database, whose tables no statement can name. The Worker's D1 API runs in
 * the Worker (fabric inner-storage-env.ts) and sends its statements here
 * through its binding (fabric bindings.ts NimbusD1Binding, session/rpc.ts
 * _rpcD1Query); the project's migrations are applied when its server builds.
 */
/**
 * The facet a project's database is: `d1:` and the project root and the
 * database, each whole (a name made of either cannot be another's).
 */
export function d1DatabaseFacetName(root, database) {
    return 'd1:' + JSON.stringify([root, database]);
}
/**
 * The database `database` of the project at `root`: its facet, got in the
 * calling request (a facet's stub belongs to the request that got it).
 * Throws when the Worker does not export NimbusD1Database.
 */
export function d1Database(ctx, root, database) {
    const databaseClass = Reflect.get(ctx.exports, 'NimbusD1Database');
    if (databaseClass === undefined)
        throw new Error("Nimbus: ctx.exports.NimbusD1Database unavailable: the Worker's main module must re-export it");
    return ctx.facets.get(d1DatabaseFacetName(root, database), async () => ({ class: databaseClass }));
}
/**
 * Apply the migrations in migrations_dir the database has not, in name
 * order, each one whole or not at all; the first that fails is logged and
 * ends the run. Answers how many were applied.
 */
export async function applyD1Migrations(opts) {
    const root = opts.root.replace(/^\/+/, '').replace(/\/+$/, '');
    const dir = opts.migrationsDir.replace(/^\/+/, '').replace(/\/+$/, '');
    const fullDir = root ? root + '/' + dir : dir;
    if (!opts.vfs.exists(fullDir))
        return 0;
    const migrations = opts.vfs.readdir(fullDir)
        .filter((e) => e.type === 'file' && e.name.endsWith('.sql'))
        .map((e) => e.name)
        .sort()
        .map((name) => ({ name, sql: opts.vfs.readFileString(fullDir + '/' + name) }));
    const outcome = await opts.database.applyMigrations(migrations);
    if (outcome.failed) {
        opts.onLog(`  \x1b[33mwarning: D1 ${opts.binding}: migration ${outcome.failed.name} failed and was rolled back: ${outcome.failed.error}\x1b[0m\n`);
    }
    return outcome.applied.length;
}
