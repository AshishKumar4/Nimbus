// In-memory mock of workerd's SqlStorage + DurableObjectState.transactionSync
// for W5 functional tests. Just enough to run SqliteVFS in Node.
//
// Supported subset:
//   - sql.exec(stmt, ...params) → iterable of result rows (Object.entries)
//   - storage.transactionSync(fn) → fn(); rollback on throw
//   - Tables created via CREATE TABLE; rows tracked in a Map
//
// SQL we need to handle (from sqlite-vfs.ts):
//   CREATE TABLE IF NOT EXISTS inodes (path PRIMARY KEY, …)
//   CREATE TABLE IF NOT EXISTS file_chunks (path, chunk_id, data, PRIMARY KEY (path, chunk_id))
//   CREATE INDEX IF NOT EXISTS …
//   ALTER TABLE inodes ADD COLUMN chunk_count …
//   SELECT chunk_count FROM inodes LIMIT 0
//   SELECT name FROM sqlite_master WHERE type='table' AND name='fs_objects'
//   SELECT path, parent_path, … FROM inodes
//   INSERT OR REPLACE INTO inodes …
//   INSERT OR REPLACE INTO file_chunks …
//   SELECT data FROM file_chunks WHERE path = ? AND chunk_id = ?
//   DELETE FROM file_chunks WHERE path = ?
//   DELETE FROM inodes WHERE path = ?
//
// Multi-row INSERT with N placeholders is parsed by counting `(?…)` groups.

class MockSqlStorage {
  constructor() {
    this.tables = new Map();
    this.failNextExecCount = 0;
    this.failNextExecMessage = 'mock SQLITE_NOMEM';
    this.execLog = [];
    this._inTransaction = false;
    this._txnSnapshot = null;
  }

  /** Inject N consecutive exec failures with a given message. */
  injectFailures(n, message = 'SQLITE_NOMEM: out of memory') {
    this.failNextExecCount = n;
    this.failNextExecMessage = message;
  }

  exec(stmt, ...params) {
    this.execLog.push({ stmt, params });
    if (this.failNextExecCount > 0) {
      this.failNextExecCount--;
      const e = new Error(this.failNextExecMessage);
      throw e;
    }
    return this._run(stmt, params);
  }

  _run(stmt, params) {
    const s = stmt.trim();
    const su = s.toUpperCase();

    // CREATE / ALTER / INDEX → no-op (table state held implicitly by inserts)
    if (su.startsWith('CREATE TABLE') || su.startsWith('CREATE INDEX') || su.startsWith('ALTER TABLE')) {
      // Ensure tables exist by name
      const m = s.match(/(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+(\w+)/i);
      if (m && !this.tables.has(m[1])) this.tables.set(m[1], []);
      return [];
    }
    if (su.startsWith('DROP TABLE')) {
      const m = s.match(/DROP TABLE(?: IF EXISTS)?\s+(\w+)/i);
      if (m) this.tables.delete(m[1]);
      return [];
    }

    // SELECT chunk_count FROM inodes LIMIT 0 — schema check, return empty
    if (su.startsWith('SELECT CHUNK_COUNT FROM INODES LIMIT 0')) return [];

    // SELECT name FROM sqlite_master WHERE … name='fs_objects' → empty (no legacy)
    if (su.startsWith("SELECT NAME FROM SQLITE_MASTER")) return [];

    // SELECT path, parent_path, … FROM inodes
    if (/^SELECT.*FROM INODES\b/.test(su)) {
      return this.tables.get('inodes') ?? [];
    }

    // SELECT data FROM file_chunks WHERE path = ? AND chunk_id = ?
    if (/^SELECT DATA FROM FILE_CHUNKS WHERE PATH = \? AND CHUNK_ID = \?$/.test(su.replace(/\s+/g, ' '))) {
      const rows = this.tables.get('file_chunks') ?? [];
      return rows.filter(r => r.path === params[0] && r.chunk_id === params[1]);
    }

    // INSERT OR REPLACE INTO inodes … VALUES (…) [, (…)] — supports multi-row
    if (/^INSERT OR REPLACE INTO INODES/.test(su)) {
      this._ensureTable('inodes');
      const rows = this.tables.get('inodes');
      const cols = ['path', 'parent_path', 'is_dir', 'size', 'mtime', 'mode', 'chunk_count'];
      // Strip duplicates by path
      // params packed as [p1, p2, p3, p4, p5, p6, p7, p1, p2, …]
      for (let i = 0; i < params.length; i += cols.length) {
        const row = {};
        for (let j = 0; j < cols.length; j++) row[cols[j]] = params[i + j];
        const idx = rows.findIndex(r => r.path === row.path);
        if (idx >= 0) rows[idx] = row;
        else rows.push(row);
      }
      return [];
    }

    // INSERT OR REPLACE INTO file_chunks … VALUES (…) [, (…)]
    if (/^INSERT OR REPLACE INTO FILE_CHUNKS/.test(su)) {
      this._ensureTable('file_chunks');
      const rows = this.tables.get('file_chunks');
      const cols = ['path', 'chunk_id', 'data'];
      for (let i = 0; i < params.length; i += cols.length) {
        const row = {};
        for (let j = 0; j < cols.length; j++) row[cols[j]] = params[i + j];
        const idx = rows.findIndex(r => r.path === row.path && r.chunk_id === row.chunk_id);
        if (idx >= 0) rows[idx] = row;
        else rows.push(row);
      }
      return [];
    }

    // DELETE FROM file_chunks WHERE path = ?
    if (/^DELETE FROM FILE_CHUNKS WHERE PATH = \?/.test(su)) {
      this._ensureTable('file_chunks');
      const rows = this.tables.get('file_chunks');
      this.tables.set('file_chunks', rows.filter(r => r.path !== params[0]));
      return [];
    }

    // DELETE FROM inodes WHERE path = ?
    if (/^DELETE FROM INODES WHERE PATH = \?/.test(su)) {
      this._ensureTable('inodes');
      const rows = this.tables.get('inodes');
      this.tables.set('inodes', rows.filter(r => r.path !== params[0]));
      return [];
    }

    // Anything else: log and return empty
    return [];
  }

  _ensureTable(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
  }

  _snapshot() {
    const snap = new Map();
    for (const [k, v] of this.tables) snap.set(k, v.map(r => ({ ...r })));
    return snap;
  }
  _restore(snap) {
    this.tables = snap;
  }
}

class MockDurableObjectStorage {
  constructor(sql) {
    this.sql = sql;
    this.kv = new Map();
  }
  transactionSync(fn) {
    const snap = this.sql._snapshot();
    try {
      this.sql._inTransaction = true;
      const r = fn();
      this.sql._inTransaction = false;
      return r;
    } catch (e) {
      this.sql._inTransaction = false;
      this.sql._restore(snap);
      throw e;
    }
  }
  async put(k, v) { this.kv.set(k, v); }
  async get(k) { return this.kv.get(k); }
  async delete(k) { return this.kv.delete(k); }
}

class MockDurableObjectState {
  constructor() {
    const sql = new MockSqlStorage();
    this.storage = new MockDurableObjectStorage(sql);
    this.storage.sql = sql; // mimic real DO API: ctx.storage.sql exists
  }
}

export function makeMockCtx() {
  const ctx = new MockDurableObjectState();
  return { ctx, sql: ctx.storage.sql };
}

export { MockSqlStorage, MockDurableObjectStorage, MockDurableObjectState };
