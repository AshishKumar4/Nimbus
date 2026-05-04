// W9 mock of workerd's SqlStorage + DurableObjectState. Just enough to
// drive ProcessLogStore's PersistAdapter against in-memory tables that
// look like a real SQLite engine.
//
// Supported subset (W9-only — not aiming for SqliteVFS coverage):
//   CREATE TABLE IF NOT EXISTS w9_proc_logs ( ... )
//   CREATE TABLE IF NOT EXISTS w9_proc_exits ( ... )
//   CREATE INDEX IF NOT EXISTS w9_proc_logs_ts ...
//   INSERT OR REPLACE INTO w9_proc_logs (pid, seq, ts, stream, data, binary) VALUES (?,?,?,?,?,?), (...) ...
//   INSERT OR REPLACE INTO w9_proc_exits (pid, code, at, reason) VALUES (?,?,?,?)
//   SELECT pid, seq, ts, stream, data, binary FROM w9_proc_logs WHERE pid = ? ORDER BY seq ASC
//   SELECT code, at, reason FROM w9_proc_exits WHERE pid = ?
//   SELECT DISTINCT pid FROM w9_proc_logs
//   DELETE FROM w9_proc_logs WHERE pid = ?
//   DELETE FROM w9_proc_logs WHERE pid = ? AND seq < ?
//   DELETE FROM w9_proc_exits WHERE pid = ?

class MockSql {
  constructor() {
    this.tables = new Map();
    this.execLog = [];
  }

  exec(stmt, ...params) {
    this.execLog.push({ stmt, params });
    const s = stmt.trim();
    const su = s.toUpperCase();

    if (su.startsWith('CREATE TABLE') || su.startsWith('CREATE INDEX')) {
      const m = s.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)/i);
      if (m && !this.tables.has(m[1])) this.tables.set(m[1], []);
      return [];
    }
    if (su.startsWith('DROP TABLE')) {
      const m = s.match(/DROP TABLE(?: IF EXISTS)?\s+(\w+)/i);
      if (m) this.tables.delete(m[1]);
      return [];
    }

    // Multi-row INSERT OR REPLACE INTO w9_proc_logs (pid, seq, ts, stream, data, binary) VALUES (?,?,?,?,?,?)[, (...)]
    if (/^INSERT OR REPLACE INTO W9_PROC_LOGS/.test(su)) {
      this._ensure('w9_proc_logs');
      const rows = this.tables.get('w9_proc_logs');
      const cols = ['pid', 'seq', 'ts', 'stream', 'data', 'binary'];
      for (let i = 0; i < params.length; i += cols.length) {
        const row = {};
        for (let j = 0; j < cols.length; j++) row[cols[j]] = params[i + j];
        const idx = rows.findIndex(r => r.pid === row.pid && r.seq === row.seq);
        if (idx >= 0) rows[idx] = row; else rows.push(row);
      }
      return [];
    }

    if (/^INSERT OR REPLACE INTO W9_PROC_EXITS/.test(su)) {
      this._ensure('w9_proc_exits');
      const rows = this.tables.get('w9_proc_exits');
      const cols = ['pid', 'code', 'at', 'reason'];
      for (let i = 0; i < params.length; i += cols.length) {
        const row = {};
        for (let j = 0; j < cols.length; j++) row[cols[j]] = params[i + j];
        const idx = rows.findIndex(r => r.pid === row.pid);
        if (idx >= 0) rows[idx] = row; else rows.push(row);
      }
      return [];
    }

    // SELECT ... FROM w9_proc_logs WHERE pid = ? ORDER BY seq ASC
    if (/^SELECT.*FROM W9_PROC_LOGS WHERE PID = \? ORDER BY SEQ/.test(su)) {
      const rows = this.tables.get('w9_proc_logs') ?? [];
      return rows.filter(r => r.pid === params[0])
        .sort((a, b) => a.seq - b.seq);
    }

    // SELECT DISTINCT pid FROM w9_proc_logs (or with optional WHERE)
    if (/^SELECT DISTINCT PID FROM W9_PROC_LOGS/.test(su)) {
      const rows = this.tables.get('w9_proc_logs') ?? [];
      const seen = new Set();
      const out = [];
      for (const r of rows) {
        if (!seen.has(r.pid)) { seen.add(r.pid); out.push({ pid: r.pid }); }
      }
      return out;
    }

    // SELECT ... FROM w9_proc_exits WHERE pid = ?
    if (/^SELECT.*FROM W9_PROC_EXITS WHERE PID = \?/.test(su)) {
      const rows = this.tables.get('w9_proc_exits') ?? [];
      return rows.filter(r => r.pid === params[0]);
    }

    // SELECT * (no WHERE) — used by tests for shape introspection
    if (/^SELECT \* FROM W9_PROC_EXITS/.test(su)) {
      return [...(this.tables.get('w9_proc_exits') ?? [])];
    }
    if (/^SELECT \* FROM W9_PROC_LOGS/.test(su)) {
      return [...(this.tables.get('w9_proc_logs') ?? [])];
    }

    // DELETE FROM w9_proc_logs WHERE pid = ? AND seq < ?
    if (/^DELETE FROM W9_PROC_LOGS WHERE PID = \? AND SEQ < \?/.test(su)) {
      this._ensure('w9_proc_logs');
      const rows = this.tables.get('w9_proc_logs');
      this.tables.set('w9_proc_logs', rows.filter(r => !(r.pid === params[0] && r.seq < params[1])));
      return [];
    }
    if (/^DELETE FROM W9_PROC_LOGS WHERE PID = \?/.test(su)) {
      this._ensure('w9_proc_logs');
      const rows = this.tables.get('w9_proc_logs');
      this.tables.set('w9_proc_logs', rows.filter(r => r.pid !== params[0]));
      return [];
    }
    if (/^DELETE FROM W9_PROC_EXITS WHERE PID = \?/.test(su)) {
      this._ensure('w9_proc_exits');
      const rows = this.tables.get('w9_proc_exits');
      this.tables.set('w9_proc_exits', rows.filter(r => r.pid !== params[0]));
      return [];
    }

    // Unknown — return empty (don't throw; mock is lenient).
    return [];
  }

  _ensure(name) { if (!this.tables.has(name)) this.tables.set(name, []); }

  _snapshot() {
    const snap = new Map();
    for (const [k, v] of this.tables) snap.set(k, v.map(r => ({ ...r })));
    return snap;
  }
  _restore(snap) { this.tables = snap; }

  countRows(table) { return (this.tables.get(table) ?? []).length; }
  rowsFor(table, pid) {
    const rs = this.tables.get(table) ?? [];
    return pid === undefined ? rs.slice() : rs.filter(r => r.pid === pid);
  }
}

class MockStorage {
  constructor(sql) {
    this.sql = sql;
    this.kv = new Map();
    this.alarmAt = null;
    this.alarmHistory = [];
  }
  transactionSync(fn) {
    const snap = this.sql._snapshot();
    try { return fn(); }
    catch (e) { this.sql._restore(snap); throw e; }
  }
  async put(k, v) { this.kv.set(k, v); }
  async get(k) { return this.kv.get(k); }
  async delete(k) { return this.kv.delete(k); }
  async setAlarm(t) { this.alarmAt = t; this.alarmHistory.push(t); }
  async getAlarm() { return this.alarmAt; }
  async deleteAlarm() { this.alarmAt = null; }
}

class MockCtx {
  constructor() {
    const sql = new MockSql();
    this.storage = new MockStorage(sql);
    this._waitUntilPromises = [];
    this._wsAutoResponse = null;
    this._hibTimeoutMs = null;
    this._acceptedSockets = [];
  }
  waitUntil(p) { this._waitUntilPromises.push(p); }
  setWebSocketAutoResponse(pair) { this._wsAutoResponse = pair; }
  setHibernatableWebSocketEventTimeout(ms) { this._hibTimeoutMs = ms; }
  acceptWebSocket(ws, tags) { this._acceptedSockets.push({ ws, tags }); }
}

export function makeMockCtx() {
  const ctx = new MockCtx();
  return { ctx, sql: ctx.storage.sql };
}

export { MockSql, MockStorage, MockCtx };
