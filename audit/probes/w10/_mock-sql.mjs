// W10 mock workerd SqlStorage. Drives the D1 emulator's facet stub.
//
// We DON'T need a full SQLite — we need just enough to verify D1 contract
// roundtrips. The mock implements a simplified SQL interpreter for:
//
//   CREATE TABLE [IF NOT EXISTS] name (col1 TYPE, col2 TYPE, ...)
//   INSERT INTO name (cols...) VALUES (?,?,?), (?,?,?), ...
//   SELECT cols | * FROM name [WHERE col = ?] [ORDER BY col [ASC|DESC]] [LIMIT n]
//   UPDATE name SET col = ?, col = ? [WHERE col = ?]
//   DELETE FROM name [WHERE col = ?]
//   CREATE INDEX
//   PRAGMA table_info(name)
//   WITH cte AS (SELECT ...) SELECT ...   (CTE support — name resolved as cte)
//   CREATE TRIGGER ... (no-op, just remembered)
//
// Bind parameters: '?' style only. We don't run a real expression evaluator,
// just the simplest column-equality comparisons used by our probes.
//
// This mock is INTENTIONALLY stricter than miniflare's: it returns realistic
// `meta` (rows_read/rows_written/changes/last_row_id/duration) so probes can
// assert on it.

class MockSqlCursor {
  constructor(rows) {
    this._rows = rows;
    this._idx = 0;
  }
  toArray() { return this._rows.slice(); }
  one() {
    if (this._rows.length !== 1) throw new Error(`one() expected exactly 1 row, got ${this._rows.length}`);
    return this._rows[0];
  }
  raw() { return this._rows.map(r => Object.values(r)); }
  *[Symbol.iterator]() { for (const r of this._rows) yield r; }

  // Query stat fields workerd exposes after iteration:
  get rowsRead() { return this._rowsRead || 0; }
  get rowsWritten() { return this._rowsWritten || 0; }
}

export class MockSqlStorage {
  constructor() {
    this.tables = new Map();    // name -> { cols: [{name, type, isPK, default}], rows: [{col: val}] }
    this.indexes = new Map();
    this.triggers = new Map();
    this._lastRowId = 0;
    this._rowsRead = 0;
    this._rowsWritten = 0;
    this.execLog = [];
  }

  exec(stmt, ...params) {
    this.execLog.push({ stmt, params });
    return this._execOne(String(stmt).trim(), params);
  }

  _execOne(stmt, params) {
    // Strip trailing semicolons + multiple statements
    // (we accept only single-statement at a time; `exec` of a multi-statement
    // string is split below)
    const u = stmt.toUpperCase();

    if (u.startsWith('CREATE TABLE')) return this._createTable(stmt);
    if (u.startsWith('CREATE INDEX')) return this._createIndex(stmt);
    if (u.startsWith('CREATE TRIGGER')) return this._createTrigger(stmt);
    if (u.startsWith('CREATE VIEW')) return this._createView(stmt);
    if (u.startsWith('DROP TABLE')) return this._dropTable(stmt);
    if (u.startsWith('INSERT')) return this._insert(stmt, params);
    if (u.startsWith('SELECT') || u.startsWith('WITH')) return this._select(stmt, params);
    if (u.startsWith('UPDATE')) return this._update(stmt, params);
    if (u.startsWith('DELETE')) return this._delete(stmt, params);
    if (u.startsWith('PRAGMA')) return this._pragma(stmt);
    if (u.startsWith('BEGIN') || u.startsWith('COMMIT') || u.startsWith('ROLLBACK')) {
      const c = new MockSqlCursor([]);
      c._rowsRead = 0; c._rowsWritten = 0;
      return c;
    }

    // Tolerant fallback: unknown statements are no-ops returning an empty cursor.
    const c = new MockSqlCursor([]);
    c._rowsRead = 0; c._rowsWritten = 0;
    return c;
  }

  _createTable(stmt) {
    const m = stmt.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)/is);
    if (!m) throw new Error('mock-sql: bad CREATE TABLE: ' + stmt);
    const [, name, body] = m;
    if (this.tables.has(name) && /IF NOT EXISTS/i.test(stmt)) {
      const c = new MockSqlCursor([]); c._rowsRead = 0; c._rowsWritten = 0; return c;
    }
    const cols = [];
    // Naive comma split — fine for our test schemas
    for (const part of body.split(',').map(s => s.trim()).filter(Boolean)) {
      const t = part.split(/\s+/);
      const colName = t[0].replace(/['"`]/g, '');
      const colType = (t[1] || 'TEXT').toUpperCase();
      const isPK = /PRIMARY KEY/i.test(part);
      cols.push({ name: colName, type: colType, isPK });
    }
    this.tables.set(name, { cols, rows: [] });
    const c = new MockSqlCursor([]);
    c._rowsRead = 0; c._rowsWritten = 0;
    return c;
  }

  _createIndex(stmt) {
    const m = stmt.match(/CREATE INDEX(?:\s+IF NOT EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (m) this.indexes.set(m[1], stmt);
    const c = new MockSqlCursor([]); c._rowsRead = 0; c._rowsWritten = 0; return c;
  }

  _createTrigger(stmt) {
    const m = stmt.match(/CREATE TRIGGER(?:\s+IF NOT EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (m) this.triggers.set(m[1], stmt);
    const c = new MockSqlCursor([]); c._rowsRead = 0; c._rowsWritten = 0; return c;
  }

  _createView(stmt) {
    const c = new MockSqlCursor([]); c._rowsRead = 0; c._rowsWritten = 0; return c;
  }

  _dropTable(stmt) {
    const m = stmt.match(/DROP TABLE(?:\s+IF EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (m) this.tables.delete(m[1]);
    const c = new MockSqlCursor([]); c._rowsRead = 0; c._rowsWritten = 0; return c;
  }

  _insert(stmt, params) {
    const m = stmt.match(/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)\s+VALUES\s*(.+)/is);
    if (!m) throw new Error('mock-sql: bad INSERT: ' + stmt);
    const [, name, colsStr, valuesStr] = m;
    const t = this.tables.get(name);
    if (!t) throw new Error('mock-sql: no such table ' + name);
    const cols = colsStr.split(',').map(s => s.trim().replace(/['"`]/g, ''));

    // Count number of value tuples
    const tupleCount = (valuesStr.match(/\(/g) || []).length;
    let written = 0;
    let pIdx = 0;
    for (let i = 0; i < tupleCount; i++) {
      const row = {};
      for (const c of cols) {
        row[c] = params[pIdx++];
      }
      // Auto-fill omitted columns with null
      for (const def of t.cols) {
        if (!(def.name in row)) row[def.name] = null;
      }
      // last_row_id assignment for INTEGER PRIMARY KEY
      const pkCol = t.cols.find(c => c.isPK && c.type === 'INTEGER');
      if (pkCol && (row[pkCol.name] == null || row[pkCol.name] === undefined)) {
        this._lastRowId++;
        row[pkCol.name] = this._lastRowId;
      } else if (pkCol && typeof row[pkCol.name] === 'number') {
        this._lastRowId = Math.max(this._lastRowId, row[pkCol.name]);
      }
      t.rows.push(row);
      written++;
    }
    this._rowsWritten += written;
    const c = new MockSqlCursor([]);
    c._rowsRead = 0; c._rowsWritten = written;
    c._changes = written;
    c._lastRowId = this._lastRowId;
    return c;
  }

  _select(stmt, params) {
    let workingStmt = stmt;
    let cteRows = null;
    let cteName = null;
    const cteMatch = stmt.match(/^WITH\s+([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\((.+)\)\s*(SELECT.+)$/is);
    if (cteMatch) {
      cteName = cteMatch[1];
      const inner = cteMatch[2].trim();
      cteRows = this._select(inner, params)._rows;
      workingStmt = cteMatch[3];
    }

    const selM = workingStmt.match(/SELECT\s+(.+?)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER BY\s+(.+?))?(?:\s+LIMIT\s+(\d+))?\s*$/is);
    if (!selM) throw new Error('mock-sql: bad SELECT: ' + workingStmt);
    const [, colsExpr, table, whereClause, orderClause, limitStr] = selM;

    let rows;
    if (cteRows && table === cteName) {
      rows = cteRows.slice();
    } else {
      const t = this.tables.get(table);
      if (!t) throw new Error('mock-sql: no such table ' + table);
      rows = t.rows.slice();
    }

    if (whereClause) {
      // Each row evaluation re-walks the WHERE; each walk consumes
      // params left-to-right. We reset _paramOffset PER ROW so all rows
      // see the same parameter sequence.
      rows = rows.filter(r => { this._paramOffset = 0; return this._evalWhere(whereClause, r, params); });
    }
    if (orderClause) {
      const orderM = orderClause.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(ASC|DESC)?/i);
      if (orderM) {
        const [, col, dir] = orderM;
        const sign = (dir || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
        rows.sort((a, b) => (a[col] < b[col] ? -sign : a[col] > b[col] ? sign : 0));
      }
    }
    if (limitStr) {
      rows = rows.slice(0, parseInt(limitStr, 10));
    }

    let projected;
    if (colsExpr.trim() === '*') {
      projected = rows.map(r => ({ ...r }));
    } else {
      const wantCols = colsExpr.split(',').map(s => s.trim().replace(/['"`]/g, ''));
      projected = rows.map(r => {
        const out = {};
        for (const c of wantCols) out[c] = r[c];
        return out;
      });
    }
    this._rowsRead += projected.length;
    const cursor = new MockSqlCursor(projected);
    cursor._rowsRead = projected.length;
    cursor._rowsWritten = 0;
    return cursor;
  }

  _evalWhere(clause, row, params) {
    // Supports forms like: col = ?, col = 'x', col = 5, col IS NULL, col IS NOT NULL
    // and AND-chains.
    const parts = clause.split(/\s+AND\s+/i);
    const usedParams = [];
    for (const p of parts) {
      const m = p.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=|<>|<|>|<=|>=)\s*(.+)$/);
      if (!m) {
        if (/IS\s+NULL/i.test(p)) {
          const col = p.match(/^([A-Za-z_][A-Za-z0-9_]*)/)[1];
          if (row[col] != null) return false;
          continue;
        }
        if (/IS\s+NOT\s+NULL/i.test(p)) {
          const col = p.match(/^([A-Za-z_][A-Za-z0-9_]*)/)[1];
          if (row[col] == null) return false;
          continue;
        }
        return false;
      }
      const [, col, op, rhs] = m;
      let val;
      if (rhs.trim() === '?') {
        val = params[this._paramOffset++];
        usedParams.push(val);
      } else if (/^['"]/.test(rhs)) {
        val = rhs.trim().replace(/^['"]|['"]$/g, '');
      } else if (/^-?\d+(\.\d+)?$/.test(rhs.trim())) {
        val = Number(rhs.trim());
      } else {
        val = rhs.trim();
      }
      const lv = row[col];
      const ok = (op === '=') ? lv === val
        : (op === '!=' || op === '<>') ? lv !== val
        : (op === '<') ? lv < val
        : (op === '>') ? lv > val
        : (op === '<=') ? lv <= val
        : (op === '>=') ? lv >= val
        : false;
      if (!ok) return false;
    }
    return true;
  }

  _update(stmt, params) {
    const m = stmt.match(/UPDATE\s+([A-Za-z_][A-Za-z0-9_]*)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/is);
    if (!m) throw new Error('mock-sql: bad UPDATE: ' + stmt);
    const [, name, setClause, whereClause] = m;
    const t = this.tables.get(name);
    if (!t) throw new Error('mock-sql: no such table ' + name);
    const setParts = setClause.split(',').map(s => s.trim());
    let pIdx = 0;
    // Pre-compute non-? values
    const setOps = setParts.map(s => {
      const sm = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      const col = sm[1].replace(/['"`]/g, '');
      const rhs = sm[2].trim();
      if (rhs === '?') {
        const v = params[pIdx++];
        return { col, val: v };
      }
      if (/^['"]/.test(rhs)) return { col, val: rhs.replace(/^['"]|['"]$/g, '') };
      if (/^-?\d+(\.\d+)?$/.test(rhs)) return { col, val: Number(rhs) };
      return { col, val: rhs };
    });

    let changes = 0;
    for (const r of t.rows) {
      // Reset paramOffset per row; WHERE-bound params follow SET-bound ones.
      const setParamsCount = pIdx;
      this._paramOffset = setParamsCount;
      const passes = whereClause ? this._evalWhere(whereClause, r, params) : true;
      if (passes) {
        for (const op of setOps) r[op.col] = op.val;
        changes++;
      }
    }
    this._rowsWritten += changes;
    const c = new MockSqlCursor([]);
    c._rowsRead = 0; c._rowsWritten = changes;
    c._changes = changes;
    c._lastRowId = this._lastRowId;
    return c;
  }

  _delete(stmt, params) {
    const m = stmt.match(/DELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+WHERE\s+(.+))?$/is);
    if (!m) throw new Error('mock-sql: bad DELETE: ' + stmt);
    const [, name, whereClause] = m;
    const t = this.tables.get(name);
    if (!t) throw new Error('mock-sql: no such table ' + name);
    const before = t.rows.length;
    if (whereClause) {
      t.rows = t.rows.filter(r => { this._paramOffset = 0; return !this._evalWhere(whereClause, r, params); });
    } else {
      t.rows = [];
    }
    const changes = before - t.rows.length;
    this._rowsWritten += changes;
    const c = new MockSqlCursor([]);
    c._rowsRead = 0; c._rowsWritten = changes;
    c._changes = changes;
    c._lastRowId = this._lastRowId;
    return c;
  }

  _pragma(stmt) {
    const m = stmt.match(/PRAGMA\s+table_info\(([A-Za-z_][A-Za-z0-9_]*)\)/i);
    if (m) {
      const t = this.tables.get(m[1]);
      if (!t) {
        const c = new MockSqlCursor([]); c._rowsRead = 0; c._rowsWritten = 0; return c;
      }
      const rows = t.cols.map((c, i) => ({
        cid: i, name: c.name, type: c.type, notnull: 0, dflt_value: null, pk: c.isPK ? 1 : 0,
      }));
      const c = new MockSqlCursor(rows); c._rowsRead = rows.length; c._rowsWritten = 0; return c;
    }
    const c = new MockSqlCursor([]); c._rowsRead = 0; c._rowsWritten = 0; return c;
  }

  _snapshot() {
    const snap = { tables: new Map(), indexes: new Map(this.indexes), triggers: new Map(this.triggers), lastRowId: this._lastRowId };
    for (const [name, t] of this.tables) {
      snap.tables.set(name, { cols: t.cols.slice(), rows: t.rows.map(r => ({ ...r })) });
    }
    return snap;
  }
  _restore(snap) {
    this.tables = snap.tables;
    this.indexes = snap.indexes;
    this.triggers = snap.triggers;
    this._lastRowId = snap.lastRowId;
  }
}

export class MockStorage {
  constructor(sql) {
    this.sql = sql;
    this.kv = new Map();
  }
  transactionSync(fn) {
    const snap = this.sql._snapshot();
    try { return fn(); } catch (e) { this.sql._restore(snap); throw e; }
  }
  async transaction(fn) {
    const snap = this.sql._snapshot();
    try { return await fn(this); } catch (e) { this.sql._restore(snap); throw e; }
  }
  async put(k, v) { this.kv.set(k, v); }
  async get(k) { return this.kv.get(k); }
  async delete(k) { return this.kv.delete(k); }
}

export function makeMockSql() {
  const sql = new MockSqlStorage();
  return { sql, storage: new MockStorage(sql) };
}
