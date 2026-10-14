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

import { facetName } from '@nimbus-sh/core/_shared/facet-name.js';
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

/**
 * The facet a project's database is: its project root and database, each
 * whole, so no two projects' databases are one, whatever the root's length.
 */
export function d1DatabaseFacetName(root: string, database: string): string {
  return facetName('d1', [root, database]);
}

export interface D1EmulatorOptions {
  /**
   * The binding's database. Called for each use: a facet's stub belongs to
   * the request that got it.
   */
  database: () => D1Database;
  binding: string;
  vfs?: CredentialedVfs;
  root?: string;                // project root for migrations_dir resolution
  migrationsDir?: string;
  onLog?: (msg: string) => void;
}

// ── D1 prepared statement ────────────────────────────────────────────────

/** What a batch sends of a statement: off the statement's own surface. */
let statementOf: (statement: D1PreparedStatementEmu) => D1Statement;

export class D1PreparedStatementEmu {
  readonly #emu: D1Emulator;
  readonly #statement: D1Statement;

  static {
    statementOf = (statement) => statement.#statement;
  }

  constructor(emu: D1Emulator, statement: D1Statement) {
    this.#emu = emu;
    this.#statement = statement;
  }

  bind(...values: SqlValue[]): D1PreparedStatementEmu {
    return new D1PreparedStatementEmu(this.#emu, { sql: this.#statement.sql, params: values });
  }

  async first(colName?: string): Promise<D1Row | SqlValue | null> {
    const r = await this.all();
    const row = r.results && r.results[0];
    if (!row) return null;
    if (colName !== undefined) return row[colName] ?? null;
    return row;
  }

  run(): Promise<D1Result> {
    return this.all();
  }

  async all(): Promise<D1Result> {
    const [result] = await this.#emu.database().query([this.#statement], false);
    return result;
  }

  async raw(): Promise<SqlValue[][]> {
    const r = await this.all();
    return (r.results || []).map((row) => Object.values(row));
  }
}

// ── D1Emulator ────────────────────────────────────────────────────────────

export class D1Emulator {
  readonly database: () => D1Database;
  #migrationsRun = false;
  readonly #binding: string;
  readonly #migrationsDir?: string;
  readonly #vfs?: CredentialedVfs;
  readonly #root?: string;
  readonly #onLog: (m: string) => void;

  constructor(opts: D1EmulatorOptions) {
    this.database = opts.database;
    this.#binding = opts.binding;
    this.#migrationsDir = opts.migrationsDir;
    this.#vfs = opts.vfs;
    this.#root = opts.root;
    this.#onLog = opts.onLog || (() => {});
  }

  prepare(query: string): D1PreparedStatementEmu {
    return new D1PreparedStatementEmu(this, { sql: query, params: [] });
  }

  /** All of `stmts` or none: the first failure rolls the batch back and is thrown. */
  batch(stmts: readonly D1PreparedStatementEmu[]): Promise<D1Result[]> {
    return this.database().query(stmts.map(statementOf), true);
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.database().exec(query);
  }

  /**
   * Apply the migrations in migrations_dir the database has not, in name
   * order, each one whole or not at all; the first that fails is logged and
   * ends the run. Once per emulator.
   */
  async applyMigrations(): Promise<{ applied: number }> {
    if (this.#migrationsRun || !this.#migrationsDir || !this.#vfs) return { applied: 0 };
    this.#migrationsRun = true;

    const root = (this.#root || '').replace(/^\/+/, '').replace(/\/+$/, '');
    const dir = this.#migrationsDir.replace(/^\/+/, '').replace(/\/+$/, '');
    const fullDir = root ? root + '/' + dir : dir;
    if (!this.#vfs.exists(fullDir)) return { applied: 0 };

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
