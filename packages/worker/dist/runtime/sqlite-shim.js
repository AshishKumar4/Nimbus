/**
 * sqlite-shim.ts — node:sqlite shim for Nimbus facets, backed by sql.js
 * (Emscripten SQLite wasm) running in-memory inside the facet isolate.
 *
 * Like node-shims.ts, this emits a raw JS string embedded in
 * the generated facet module. The emitted block:
 *
 *   1. Boots the sql.js engine LAZILY AND SYNCHRONOUSLY on the first
 *      DatabaseSync open (`__getSQL`): it calls the prepared glue factory
 *      with a synchronous `instantiateWasm` hook fed the pre-compiled
 *      WebAssembly.Module from `globalThis.__nimbusSqliteWasmModule`
 *      (attached by the facet module map) and captures the ready Module
 *      synchronously (sql.js uses the caller's config object AS the
 *      Emscripten Module and runs postRun in the same tick when
 *      instantiation is synchronous). The ready namespace is stashed on
 *      `globalThis.__nimbusSQL`. Laziness matters: the engine boot costs
 *      ~48 MiB of facet memory (measured live 2026-07-21, #35), which a
 *      process that never opens a DB — e.g. the opencode attach TUI
 *      client — must not pay inside a memory-capped facet. A caller that
 *      certainly WILL open a DB (the opencode serve facet) boots eagerly
 *      via `globalThis.__nimbusInitSqlite()` to keep its proven boot shape.
 *
 *   2. Defines `__sqliteMod` = { DatabaseSync, ... } registered as
 *      builtins.sqlite, which only node:sqlite names (node-shims.ts __nimbusBuiltinId).
 *
 * Persistence model: a file-backed DatabaseSync is the process's file, read
 * and written through the process's own filesystem (`__fsMod`): it loads
 * the file's bytes with readFileSync on open (a missing file is a new
 * database), and on close writes `db.export()` back with writeFileSync when
 * the database changed. So the next open in the same run sees what the
 * close wrote, and the session gets it in program order, as any other write.
 * Whole-DB image, single in-memory connection, no page-level disk IO, no
 * cross-process WAL.
 *
 * Scope (opencode's method matrix): DatabaseSync(path|:memory:, options)
 * with .prepare/.exec/.close/.loadExtension(throws); StatementSync with
 * .all/.run/.get/.setReadBigInts/.setReturnArrays. Anything else throws a
 * clear "node:sqlite: <method> not supported" — never faked.
 *
 * Runtime scope dependency (in scope where SHIMS is interpolated):
 *   - __fsMod: the process's node:fs (readFileSync, writeFileSync)
 */
import { SQLJS_GLUE_FN_BODY } from '../sqlite-wasm-bundle.generated.js';
/**
 * Module-init preamble that prepares the sql.js `initSqlJs` factory.
 *
 * workerd disallows code-generation-from-strings (`new Function`, `eval`)
 * at REQUEST time inside dynamic-worker isolates, but ALLOWS it during
 * module evaluation / startup. The sql.js glue can only be turned into a
 * callable via `new Function`, so this runs at the facet's top level —
 * prepended (alongside the static `import "sqlite.wasm"`) by the facet
 * code generators ONLY when the bundle imports node:sqlite.
 *
 * It evaluates the glue with a globalThis Proxy that masks the environment
 * sentinels sql.js sniffs — `process` (ENVIRONMENT_IS_NODE; avoids
 * require("node:fs")/process.argv), `WorkerGlobalScope` and `document`
 * (ENVIRONMENT_IS_WORKER/WEB; avoids `self.location.href`, which is
 * undefined in workerd dynamic-worker isolates and would throw). With all
 * three masked, sql.js takes the bare path: no fetch/fs wasm loading (we
 * supply instantiateWasm), crypto.getRandomValues for RNG. The resulting
 * factory is parked on globalThis.__nimbusSqlJsFactory; the request-time
 * boot (generateSqliteShimCode) calls it with an instantiateWasm hook.
 */
export function generateSqliteFacetPreamble() {
    return `
const __nimbusSqlJsGlueBody = ${JSON.stringify(SQLJS_GLUE_FN_BODY)};
{
  const __sqljsMaskedGlobals = new Set(["process", "WorkerGlobalScope", "document"]);
  const __maskedGlobal = new Proxy(globalThis, {
    get(target, prop, receiver) {
      if (__sqljsMaskedGlobals.has(prop)) return undefined;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
    has(target, prop) {
      if (__sqljsMaskedGlobals.has(prop)) return false;
      return Reflect.has(target, prop);
    },
  });
  globalThis.__nimbusSqlJsFactory = new Function("globalThis", __nimbusSqlJsGlueBody)(__maskedGlobal);
}
`;
}
export function generateSqliteShimCode() {
    return `
// ═══════════════════════════════════════════════════════════════════════
// ── node:sqlite shim (sql.js-backed, Nimbus) ────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

const __sqliteMod = (() => {
  function __unsupported(name) {
    return new Error("node:sqlite: " + name + " not supported");
  }

  // Engine boot, run lazily on the FIRST DatabaseSync open — or eagerly
  // via __nimbusInitSqlite by a caller that KNOWS it will open a DB (the
  // opencode serve facet: it serves sessions from the DB within its first
  // requests, and booting eagerly there keeps its long-proven boot shape —
  // removing the eager boot live-wedged serve's handler-time chunk import
  // of server/server, the #20 shape-sensitivity, 2026-07-21).
  //
  // The sql.js glue is evaluated via \`new Function\` at MODULE-INIT time
  // (generateSqliteFacetPreamble, prepended to the facet) because workerd
  // disallows code-generation-from-strings at request time; by now
  // globalThis.__nimbusSqlJsFactory is the prepared initSqlJs factory. We
  // only call it + instantiate the pre-compiled WebAssembly.Module (both
  // allowed at request time). Synchronicity is structural, not lucky:
  // sql.js uses the caller's config object AS the Emscripten Module, and
  // with a synchronous \`instantiateWasm\` hook (and no \`setStatus\`)
  // Emscripten runs runtime init + postRun in the same tick — so the
  // config/Module closure carries the ready { Database } namespace before
  // this function returns, which is exactly what node:sqlite's
  // synchronous constructor needs. Fail loud if that structure ever
  // changes in a sql.js upgrade.
  function __getSQL() {
    if (globalThis.__nimbusSQL) return globalThis.__nimbusSQL;
    const wasmModule = globalThis.__nimbusSqliteWasmModule;
    if (!wasmModule) {
      throw new Error(
        "node:sqlite: sql.js wasm module not attached to this facet " +
        "(internal: __nimbusSqliteWasmModule missing — module-map wiring bug)"
      );
    }
    const initSqlJs = globalThis.__nimbusSqlJsFactory;
    if (typeof initSqlJs !== "function") {
      throw new Error(
        "node:sqlite: sql.js factory not prepared at module init " +
        "(internal: __nimbusSqlJsFactory missing — facet-preamble wiring bug)"
      );
    }
    const engine = {
      // Feed the pre-compiled WebAssembly.Module to sql.js so it never
      // calls WebAssembly.compile(bytes) (blocked in facets at request
      // time). The hook gets the imports object and a callback; we
      // instantiate synchronously and invoke it.
      instantiateWasm(imports, successCallback) {
        const instance = new WebAssembly.Instance(wasmModule, imports);
        successCallback(instance, wasmModule);
        return instance.exports;
      },
    };
    let ready = false;
    engine.postRun = [() => { ready = true; }];
    initSqlJs(engine);
    if (!ready || typeof engine.Database !== "function") {
      throw new Error(
        "node:sqlite: sql.js did not complete synchronous init " +
        "(internal: the glue's Module/postRun structure changed — see sqlite-shim.ts __getSQL)"
      );
    }
    globalThis.__nimbusSQL = engine;
    return engine;
  }

  // Idempotent eager boot for callers that will certainly open a DB.
  // Same engine, same failure modes as the lazy path — just earlier.
  globalThis.__nimbusInitSqlite = async function __nimbusInitSqlite() {
    return __getSQL();
  };

  // The database file's bytes, or null for a database not yet written
  // (missing or empty). Any other refusal is the open's own.
  function __readDbBytes(path) {
    let bytes;
    try { bytes = __fsMod.readFileSync(path); }
    catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
    return bytes.length ? bytes : null;
  }

  class StatementSync {
    constructor(db, sql) {
      this.__db = db;
      this.__sql = sql;
      this.__readBigInts = false;
      this.__returnArrays = false;
    }

    setReadBigInts(enabled) {
      this.__readBigInts = !!enabled;
      return this;
    }

    setReturnArrays(enabled) {
      this.__returnArrays = !!enabled;
      return this;
    }

    setAllowBareNamedParameters() {
      throw __unsupported("StatementSync.prototype.setAllowBareNamedParameters");
    }

    // sql.js stmt API drives all reads/writes. We prepare a fresh stmt
    // per call and free it deterministically so no wasm handle leaks.
    __prepare(params) {
      const handle = this.__db.__raw;
      if (!handle) throw new Error("node:sqlite: database is closed");
      const stmt = handle.prepare(this.__sql);
      if (params.length > 0) {
        stmt.bind(__bindParams(params));
      }
      return stmt;
    }

    all(...params) {
      this.__db.__noteRead();
      const stmt = this.__prepare(params);
      const rows = [];
      try {
        const cols = stmt.getColumnNames();
        while (stmt.step()) {
          rows.push(this.__shapeRow(stmt, cols));
        }
      } finally {
        stmt.free();
      }
      return rows;
    }

    get(...params) {
      this.__db.__noteRead();
      const stmt = this.__prepare(params);
      try {
        if (!stmt.step()) return undefined;
        const cols = stmt.getColumnNames();
        return this.__shapeRow(stmt, cols);
      } finally {
        stmt.free();
      }
    }

    run(...params) {
      const handle = this.__db.__raw;
      if (!handle) throw new Error("node:sqlite: database is closed");
      const stmt = this.__prepare(params);
      try {
        stmt.step();
      } finally {
        stmt.free();
      }
      this.__db.__dirty = true;
      const changes = handle.getRowsModified();
      const lastRowId = __lastInsertRowid(handle);
      return {
        changes: this.__readBigInts ? BigInt(changes) : changes,
        lastInsertRowid: this.__readBigInts ? BigInt(lastRowId) : lastRowId,
      };
    }

    iterate() {
      throw __unsupported("StatementSync.prototype.iterate");
    }

    columns() {
      throw __unsupported("StatementSync.prototype.columns");
    }

    __shapeRow(stmt, cols) {
      const raw = stmt.get();
      if (this.__returnArrays) {
        return raw.map((v) => this.__coerce(v));
      }
      const obj = {};
      for (let i = 0; i < cols.length; i++) {
        obj[cols[i]] = this.__coerce(raw[i]);
      }
      return obj;
    }

    // sql.js returns numbers for INTEGER/REAL, strings for TEXT,
    // Uint8Array for BLOB, null for NULL. node:sqlite returns bigint for
    // INTEGER columns when setReadBigInts(true); otherwise number.
    __coerce(value) {
      if (this.__readBigInts && typeof value === "number" && Number.isInteger(value)) {
        return BigInt(value);
      }
      return value;
    }
  }

  function __bindParams(params) {
    // node:sqlite accepts positional params (array) and named params via a
    // single object argument. sql.js bind() takes an array (positional) or
    // an object keyed by ":name"/"@name"/"$name".
    if (params.length === 1 && __isNamedParamObject(params[0])) {
      return __normalizeNamedParams(params[0]);
    }
    return params.map(__coerceBindValue);
  }

  function __isNamedParamObject(v) {
    return (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      !(v instanceof Uint8Array) &&
      !(v instanceof ArrayBuffer)
    );
  }

  function __normalizeNamedParams(obj) {
    const out = {};
    for (const key of Object.keys(obj)) {
      const prefixed = /^[:@$]/.test(key) ? key : ":" + key;
      out[prefixed] = __coerceBindValue(obj[key]);
    }
    return out;
  }

  function __coerceBindValue(v) {
    if (typeof v === "bigint") {
      // sql.js binds JS numbers; SQLite INTEGER is 64-bit. Within the
      // safe-integer range we pass a number; beyond it we throw rather
      // than silently lose precision.
      if (v >= -9007199254740991n && v <= 9007199254740991n) return Number(v);
      throw new Error("node:sqlite: bigint parameter exceeds safe-integer range");
    }
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return v;
  }

  function __lastInsertRowid(handle) {
    // sql.js does not expose last_insert_rowid() directly; query it.
    const stmt = handle.prepare("SELECT last_insert_rowid()");
    try {
      stmt.step();
      const row = stmt.get();
      return row && row.length ? Number(row[0]) : 0;
    } finally {
      stmt.free();
    }
  }

  class DatabaseSync {
    constructor(path, options) {
      const opts = options || {};
      this.__path = typeof path === "string" ? path : "";
      this.__memory = !this.__path || this.__path === ":memory:";
      this.__open = false;
      this.__raw = null;
      // Whether a close has anything to write back (__changed): run() and
      // exec() may change what SQLite does not count (ANALYZE's statistics, a
      // VACUUM's layout), so either marks the database dirty. A row method may
      // change it too (INSERT ... RETURNING): its connection's state is taken
      // before the first one runs, and a close compares it.
      this.__dirty = false;
      this.__written = null;
      const open = opts.open === undefined ? true : !!opts.open;
      if (open) this.__doOpen();
    }

    __doOpen() {
      const SQL = __getSQL();
      const bytes = this.__memory ? null : __readDbBytes(this.__path);
      this.__raw = bytes ? new SQL.Database(bytes) : new SQL.Database();
      this.__open = true;
    }

    __noteRead() {
      if (!this.__memory && !this.__dirty && this.__written === null) this.__written = this.__state();
    }

    // The database's content as SQLite counts it: the rows any statement
    // changed (whichever method ran it, an INSERT ... RETURNING through all()
    // included), its schema, and the header fields a program sets.
    __state() {
      const stmt = this.__raw.prepare("SELECT total_changes(), (SELECT schema_version FROM pragma_schema_version()), (SELECT user_version FROM pragma_user_version()), (SELECT application_id FROM pragma_application_id())");
      try { stmt.step(); return stmt.get().join(","); } finally { stmt.free(); }
    }

    __changed() {
      return this.__dirty || (this.__written !== null && this.__state() !== this.__written);
    }

    open() {
      if (this.__open) return;
      this.__doOpen();
    }

    get isOpen() {
      return this.__open;
    }

    prepare(sql) {
      if (!this.__open) throw new Error("node:sqlite: database is not open");
      return new StatementSync(this, String(sql));
    }

    exec(sql) {
      if (!this.__open) throw new Error("node:sqlite: database is not open");
      // sql.js run() executes one-or-more statements with no result rows;
      // PRAGMAs are honored against the single in-memory connection (or
      // no-op where not meaningful for an in-memory whole-DB snapshot).
      this.__raw.run(String(sql));
      this.__dirty = true;
    }

    function() {
      throw __unsupported("DatabaseSync.prototype.function");
    }

    aggregate() {
      throw __unsupported("DatabaseSync.prototype.aggregate");
    }

    createSession() {
      throw __unsupported("DatabaseSync.prototype.createSession");
    }

    applyChangeset() {
      throw __unsupported("DatabaseSync.prototype.applyChangeset");
    }

    enableLoadExtension() {
      throw __unsupported("DatabaseSync.prototype.enableLoadExtension");
    }

    loadExtension() {
      throw __unsupported("DatabaseSync.prototype.loadExtension");
    }

    // Write the database's image back to its file, through the process's
    // filesystem, when it changed since it was opened or last written.
    __flush() {
      if (this.__memory || !this.__open || !this.__changed()) return;
      const bytes = this.__raw.export();
      __fsMod.writeFileSync(this.__path, bytes);
      this.__dirty = false;
      this.__written = null;
    }

    close() {
      if (!this.__open) return;
      try {
        this.__flush();
      } finally {
        try { this.__raw.close(); } catch {}
        this.__raw = null;
        this.__open = false;
      }
    }

    [Symbol.dispose]() {
      this.close();
    }
  }

  return { DatabaseSync, StatementSync };
})();
`;
}
