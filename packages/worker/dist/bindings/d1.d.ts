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
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { NimbusD1Database } from './d1-database.js';
/**
 * The facet a project's database is: its project root and database, each
 * whole, so no two projects' databases are one, whatever the root's length.
 */
export declare function d1DatabaseFacetName(root: string, database: string): string;
/**
 * The database `database` of the project at `root`: its facet, got in the
 * calling request (a facet's stub belongs to the request that got it).
 * Throws when the Worker does not export NimbusD1Database.
 */
export declare function d1Database(ctx: DurableObjectState, root: string, database: string): Fetcher<NimbusD1Database>;
export interface D1MigrationsOptions {
    /** The binding's database, got for this run. */
    database: Fetcher<NimbusD1Database>;
    binding: string;
    vfs: CredentialedVfs;
    /** The project root migrations_dir is under. */
    root: string;
    migrationsDir: string;
    onLog: (msg: string) => void;
}
/**
 * Apply the migrations in migrations_dir the database has not, in name
 * order, each one whole or not at all; the first that fails is logged and
 * ends the run. Answers how many were applied.
 */
export declare function applyD1Migrations(opts: D1MigrationsOptions): Promise<number>;
//# sourceMappingURL=d1.d.ts.map