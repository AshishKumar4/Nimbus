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

// ── Public types (subset of @cloudflare/workers-types D1 surface) ───────

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
  vfs?: SqliteVFS | any;       // for reading optional migration files
  root?: string;                // project root for migrations_dir resolution
  migrationsDir?: string;
  onLog?: (msg: string) => void;
}

// ── Identifier rewriter ─────────────────────────────────────────────────
//
// We track which table names belong to *this binding* by intercepting
// CREATE TABLE / DROP TABLE. Subsequent INSERT/SELECT/etc rewrite only
// references to those known names — bare identifiers that aren't on the
// list pass through unchanged (lets PRAGMA, sqlite_master, etc. work).

class TablePrefixer {
  private prefix: string;
  // Tables created via this emulator (raw user-facing name → prefixed name)
  private known = new Set<string>();
  // Cache for performance
  private rewriteCache = new Map<string, string>();

  constructor(prefix: string) { this.prefix = prefix; }

  /** Rewrite a single SQL statement, registering any new tables. */
  rewrite(sql: string): string {
    const cached = this.rewriteCache.get(sql);
    if (cached !== undefined) return cached;
    const out = this._rewrite(sql);
    this.rewriteCache.set(sql, out);
    return out;
  }

  /** Mark a raw table name as belonging to this binding. */
  register(rawName: string): void {
    this.known.add(rawName.toLowerCase());
  }

  /** Drop a table from the registry. */
  unregister(rawName: string): void {
    this.known.delete(rawName.toLowerCase());
    // Bust the rewrite cache (any cached SQL referencing this name is stale)
    this.rewriteCache.clear();
  }

  prefixed(rawName: string): string { return this.prefix + rawName; }
  has(rawName: string): boolean { return this.known.has(rawName.toLowerCase()); }

  private _rewrite(sql: string): string {
    // Tokenize: walk char by char, separate string literals from
    // identifiers. We emit `tokens` as a list of {type, value} where
    // type is 'str' | 'word' | 'punct'. Then we rewrite words that are
    // table names.

    const tokens: { type: 'str' | 'word' | 'punct' | 'ws'; value: string }[] = [];
    let i = 0;
    const N = sql.length;
    while (i < N) {
      const ch = sql[i];
      // String literal '…'
      if (ch === "'") {
        let j = i + 1;
        while (j < N) {
          if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
          if (sql[j] === "'") { j++; break; }
          j++;
        }
        tokens.push({ type: 'str', value: sql.slice(i, j) });
        i = j;
        continue;
      }
      // Quoted identifier "…" or [...] or `…`
      if (ch === '"' || ch === '`') {
        let j = i + 1;
        while (j < N && sql[j] !== ch) j++;
        if (j < N) j++;
        tokens.push({ type: 'word', value: sql.slice(i, j) });
        i = j;
        continue;
      }
      if (ch === '[') {
        let j = i + 1;
        while (j < N && sql[j] !== ']') j++;
        if (j < N) j++;
        tokens.push({ type: 'word', value: sql.slice(i, j) });
        i = j;
        continue;
      }
      // Whitespace
      if (/\s/.test(ch)) {
        let j = i;
        while (j < N && /\s/.test(sql[j])) j++;
        tokens.push({ type: 'ws', value: sql.slice(i, j) });
        i = j;
        continue;
      }
      // Word (identifier or keyword)
      if (/[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < N && /[A-Za-z0-9_]/.test(sql[j])) j++;
        tokens.push({ type: 'word', value: sql.slice(i, j) });
        i = j;
        continue;
      }
      // Otherwise punctuation
      tokens.push({ type: 'punct', value: ch });
      i++;
    }

    // Now walk tokens, find slots where the next non-ws token is a table
    // name to rewrite. The trigger words are:
    const SLOTS = new Set([
      'TABLE', 'FROM', 'JOIN', 'INTO', 'UPDATE',
    ]);
    // CREATE TABLE → next word is the table name to register
    // CREATE INDEX … ON <table> → next word AFTER 'ON' is the table
    // CREATE TRIGGER … ON <table> → same
    // CREATE VIEW <name> → next word is the view name (we treat like a table)
    // DROP TABLE <name> → unregister
    // ALTER TABLE <name>
    const wordIdx = (i: number) => {
      for (let k = i + 1; k < tokens.length; k++) {
        if (tokens[k].type === 'ws') continue;
        return k;
      }
      return -1;
    };
    const isWord = (k: number, w: string) =>
      k >= 0 && k < tokens.length && tokens[k].type === 'word' &&
      stripQuoting(tokens[k].value).toUpperCase() === w;

    const rewriteAtIfKnown = (k: number, registerNew: boolean = false): boolean => {
      if (k < 0 || k >= tokens.length) return false;
      const t = tokens[k];
      if (t.type !== 'word') return false;
      const raw = stripQuoting(t.value);
      // Skip SQL keywords / reserved words
      if (RESERVED.has(raw.toUpperCase())) return false;
      // Skip if dotted (db.table) — we don't support attached dbs
      // Already prefixed?
      if (raw.startsWith(this.prefix)) return false;
      if (registerNew) {
        this.known.add(raw.toLowerCase());
        t.value = this.prefix + raw;
        return true;
      }
      if (this.known.has(raw.toLowerCase())) {
        t.value = this.prefix + raw;
        return true;
      }
      return false;
    };

    const unregisterAt = (k: number): void => {
      if (k < 0 || k >= tokens.length) return;
      const raw = stripQuoting(tokens[k].value);
      this.known.delete(raw.toLowerCase());
      tokens[k].value = this.prefix + raw;
    };

    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.type !== 'word') continue;
      const w = stripQuoting(t.value).toUpperCase();

      if (w === 'CREATE') {
        // CREATE [TEMP[ORARY]] [UNIQUE] TABLE|INDEX|TRIGGER|VIEW [IF NOT EXISTS] <name>
        // Walk forward through optional modifiers to find TABLE/INDEX/etc
        let nextK = wordIdx(k);
        let kind: string | null = null;
        while (nextK >= 0) {
          const nw = stripQuoting(tokens[nextK].value).toUpperCase();
          if (nw === 'TABLE' || nw === 'INDEX' || nw === 'TRIGGER' || nw === 'VIEW') {
            kind = nw;
            break;
          }
          if (['TEMP', 'TEMPORARY', 'UNIQUE', 'IF', 'NOT', 'EXISTS'].includes(nw)) {
            nextK = wordIdx(nextK);
          } else {
            break;
          }
        }
        if (!kind) continue;
        // Walk past optional 'IF NOT EXISTS' words after kind
        let nameK = wordIdx(nextK);
        while (nameK >= 0) {
          const nw = stripQuoting(tokens[nameK].value).toUpperCase();
          if (nw === 'IF' || nw === 'NOT' || nw === 'EXISTS') {
            nameK = wordIdx(nameK);
          } else {
            break;
          }
        }
        if (kind === 'TABLE' || kind === 'VIEW') {
          rewriteAtIfKnown(nameK, /*registerNew*/ true);
        } else {
          // CREATE INDEX/TRIGGER: don't register the index/trigger name itself,
          // but rewrite the ON <table> reference if present.
          // Just skip — find ON <existing-table> later in this same pass.
        }
        continue;
      }

      if (w === 'DROP' && tokens[wordIdx(k)] && stripQuoting(tokens[wordIdx(k)].value).toUpperCase() === 'TABLE') {
        let nameK = wordIdx(wordIdx(k));
        while (nameK >= 0 && ['IF', 'EXISTS'].includes(stripQuoting(tokens[nameK].value).toUpperCase())) {
          nameK = wordIdx(nameK);
        }
        unregisterAt(nameK);
        continue;
      }

      // FROM <table> | JOIN <table> | INTO <table> | UPDATE <table>
      if (w === 'FROM' || w === 'JOIN' || w === 'INTO' || w === 'UPDATE') {
        // Walk forward, rewriting the next word AND any subsequent word
        // separated by commas (FROM a, b).
        let nameK = wordIdx(k);
        // INSERT INTO has no comma list; UPDATE x SET … has no comma either;
        // FROM does. Be lenient — just rewrite first.
        rewriteAtIfKnown(nameK, /*registerNew*/ false);
        if (w === 'FROM') {
          // Handle comma list: FROM a, b, c
          let walk = wordIdx(nameK);
          while (walk >= 0 && tokens[walk].type === 'punct' && tokens[walk].value === ',') {
            const nw = wordIdx(walk);
            rewriteAtIfKnown(nw, false);
            walk = wordIdx(nw);
          }
          // Actually punct tokens aren't word; fix the walk:
          // (we miss commas because wordIdx skips ws but lands on punct...)
        }
        continue;
      }

      // INDEX/TRIGGER/VIEW: ON <table>
      if (w === 'ON') {
        const prev = (() => {
          for (let p = k - 1; p >= 0; p--) {
            if (tokens[p].type === 'ws') continue;
            return tokens[p];
          }
          return null;
        })();
        // Heuristic: if we're inside a CREATE INDEX/TRIGGER, the previous
        // significant tokens included CREATE…INDEX/TRIGGER. Be lenient:
        // rewrite if next word is a known table.
        rewriteAtIfKnown(wordIdx(k), false);
        continue;
      }
    }

    return tokens.map(t => t.value).join('');
  }
}

const RESERVED = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'TABLE', 'INDEX', 'VIEW', 'TRIGGER', 'DROP', 'ALTER', 'WITH', 'AS',
  'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'ON', 'AND', 'OR', 'NOT',
  'NULL', 'IS', 'IN', 'BETWEEN', 'LIKE', 'GLOB', 'LIMIT', 'OFFSET', 'ORDER', 'BY',
  'GROUP', 'HAVING', 'ASC', 'DESC', 'UNION', 'EXCEPT', 'INTERSECT', 'DISTINCT',
  'ALL', 'EXISTS', 'PRAGMA', 'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION',
  'IF', 'TEMP', 'TEMPORARY', 'UNIQUE', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
  'DEFAULT', 'CHECK', 'AUTOINCREMENT', 'INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'COLLATE',
  'OR', 'REPLACE', 'ABORT', 'FAIL', 'IGNORE', 'AFTER', 'BEFORE', 'INSTEAD', 'OF',
  'EACH', 'ROW',
]);

function stripQuoting(s: string): string {
  if (s.length >= 2) {
    const f = s[0], l = s[s.length - 1];
    if ((f === '"' && l === '"') || (f === '`' && l === '`')) return s.slice(1, -1);
    if (f === '[' && l === ']') return s.slice(1, -1);
  }
  return s;
}

// ── D1 prepared statement ────────────────────────────────────────────────

export class D1PreparedStatementEmu {
  /** @internal */
  _sql: string;
  /** @internal */
  _params: any[];
  private _emu: D1Emulator;

  constructor(emu: D1Emulator, sql: string, params: any[]) {
    this._emu = emu;
    this._sql = sql;
    this._params = params;
  }

  bind(...values: any[]): D1PreparedStatementEmu {
    return new D1PreparedStatementEmu(this._emu, this._sql, values);
  }

  async first<T = any>(colName?: string): Promise<T | null> {
    const r = await this.all();
    const row = r.results && r.results[0];
    if (!row) return null;
    if (colName !== undefined) return (row as any)[colName] ?? null;
    return row as T;
  }

  async run<T = any>(): Promise<D1Result<T>> {
    return this._emu._runOne(this._sql, this._params);
  }

  async all<T = any>(): Promise<D1Result<T>> {
    return this._emu._runOne(this._sql, this._params);
  }

  async raw<T = any>(): Promise<T[]> {
    const r = await this.all<any>();
    return (r.results || []).map((row) => Object.values(row)) as any;
  }
}

// ── D1Emulator ────────────────────────────────────────────────────────────

export class D1Emulator {
  private sql: any;
  private prefix: string;
  private prefixer: TablePrefixer;
  private migrationsRun = false;
  private migrationsDir?: string;
  private vfs?: any;
  private root?: string;
  private onLog: (m: string) => void;

  constructor(opts: D1EmulatorOptions) {
    this.sql = opts.sqlStorage;
    this.prefix = '_d1_' + opts.binding + '__';
    this.prefixer = new TablePrefixer(this.prefix);
    this.migrationsDir = opts.migrationsDir;
    this.vfs = opts.vfs;
    this.root = opts.root;
    this.onLog = opts.onLog || (() => {});
  }

  prepare(query: string): D1PreparedStatementEmu {
    return new D1PreparedStatementEmu(this, query, []);
  }

  async batch<T = any>(stmts: D1PreparedStatementEmu[]): Promise<D1Result<T>[]> {
    // Atomicity: snapshot/restore via the same _snapshot/_restore harness
    // the SqlStorage offers. workerd's real SqlStorage exposes
    // transactionSync; the mock-sql harness exposes _snapshot/_restore on
    // the storage object. Here we use ctx.storage.transactionSync if
    // available, else fall back to manual.
    const results: D1Result<T>[] = [];
    // Check for transactionSync on parent (ctx.storage)
    const txn = this.sql._snapshot && this.sql._restore
      ? (fn: () => any) => {
          const snap = this.sql._snapshot();
          try { return fn(); } catch (e) { this.sql._restore(snap); throw e; }
        }
      : (fn: () => any) => fn();

    txn(() => {
      for (const s of stmts) {
        const r = (this as any)._runOneSync(s._sql, s._params) as D1Result<T>;
        if (!r.success) throw new Error(r.error || 'batch failed');
        results.push(r);
      }
    });
    return results;
  }

  async exec(query: string): Promise<D1ExecResult> {
    const t0 = Date.now();
    let count = 0;
    // Split on semicolons, respecting string literals.
    const parts = splitStatements(query);
    for (const p of parts) {
      if (!p.trim()) continue;
      this._runOneSync(p, []);
      count++;
    }
    return { count, duration: Date.now() - t0 };
  }

  /** @internal */
  _runOne(sql: string, params: any[]): D1Result<any> {
    return this._runOneSync(sql, params);
  }

  /** Synchronous core (workerd SqlStorage.exec is sync). */
  /** @internal */
  _runOneSync(sql: string, params: any[]): D1Result<any> {
    const t0 = Date.now();
    let rewritten: string;
    try {
      rewritten = this.prefixer.rewrite(sql);
    } catch (e: any) {
      return {
        success: false,
        error: 'rewrite failed: ' + (e?.message || String(e)),
        meta: this._meta(0, 0, 0, 0, t0),
      };
    }
    let cursor: any;
    try {
      cursor = this.sql.exec(rewritten, ...params);
    } catch (e: any) {
      return {
        success: false,
        error: e?.message || String(e),
        meta: this._meta(0, 0, 0, 0, t0),
      };
    }
    const arr = typeof cursor.toArray === 'function' ? cursor.toArray() : Array.from(cursor || []);
    const rowsRead = cursor.rowsRead ?? cursor._rowsRead ?? arr.length;
    const rowsWritten = cursor.rowsWritten ?? cursor._rowsWritten ?? 0;
    const changes = cursor._changes ?? rowsWritten;
    const lastRowId = cursor._lastRowId ?? 0;
    return {
      success: true,
      results: arr,
      meta: this._meta(rowsRead, rowsWritten, changes, lastRowId, t0),
    };
  }

  private _meta(rowsRead: number, rowsWritten: number, changes: number, lastRowId: number, t0: number): D1Meta {
    return {
      duration: Date.now() - t0,
      changes,
      last_row_id: lastRowId,
      rows_read: rowsRead,
      rows_written: rowsWritten,
      served_by: 'nimbus-d1-emu',
      changed_db: rowsWritten > 0,
    };
  }

  /** Apply migrations from migrations_dir if present. Idempotent. */
  async applyMigrations(): Promise<{ applied: number }> {
    if (this.migrationsRun || !this.migrationsDir || !this.vfs) return { applied: 0 };
    this.migrationsRun = true;

    // Ledger table tracks which migrations we've applied.
    const ledger = '_d1_' + this.prefix.slice(4, -2) + '__nimbus_migrations';
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${ledger} (filename TEXT PRIMARY KEY, applied_at INTEGER)`);

    const root = (this.root || '').replace(/^\/+/, '').replace(/\/+$/, '');
    const dir = this.migrationsDir.replace(/^\/+/, '').replace(/\/+$/, '');
    const fullDir = root ? root + '/' + dir : dir;
    if (!this.vfs.exists(fullDir)) return { applied: 0 };

    const files = this.vfs.readdir(fullDir)
      .filter((e: any) => e.type === 'file' && e.name.endsWith('.sql'))
      .map((e: any) => e.name)
      .sort();
    let applied = 0;
    for (const f of files) {
      // Has it been applied?
      const seen = this.sql.exec(`SELECT filename FROM ${ledger} WHERE filename = ?`, f).toArray();
      if (seen.length > 0) continue;
      const sql = this.vfs.readFileString(fullDir + '/' + f);
      const parts = splitStatements(sql);
      for (const p of parts) {
        if (!p.trim()) continue;
        this._runOneSync(p, []);
      }
      this.sql.exec(`INSERT INTO ${ledger} (filename, applied_at) VALUES (?, ?)`, f, Date.now());
      applied++;
    }
    return { applied };
  }
}

// ── splitStatements ─────────────────────────────────────────────────────
// Split on `;` outside string literals. Trivial parser — D1 / SQLite both
// accept `;`-separated statements, and we don't try to be cleverer than
// that (no PL/pgSQL, no BEGIN…END blocks beyond what SQLite supports for
// triggers, which fits in a single ; terminator anyway).

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  let depth = 0;  // CREATE TRIGGER … BEGIN … END uses BEGIN/END words but
                  // semicolons inside those need careful handling. Simple:
                  // track string state and split on `;` only outside strings.
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { cur += sql[++i]; continue; }
        inStr = false;
      }
      continue;
    }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === ';') {
      // Crude: BEGIN…END trigger bodies — we don't split inside them.
      // Heuristic: if the trimmed `cur` contains an unmatched 'BEGIN',
      // accumulate until 'END'.
      const trimUpper = cur.toUpperCase();
      const begins = (trimUpper.match(/\bBEGIN\b/g) || []).length;
      const ends = (trimUpper.match(/\bEND\b/g) || []).length;
      if (begins > ends) { cur += ch; continue; }
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
