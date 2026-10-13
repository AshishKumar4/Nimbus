#!/usr/bin/env bun
// Behavior tests for the node:sqlite shim (sql.js-backed) emitted by
// generateSqliteShimCode(). Drives the generated __sqliteMod the same way
// a facet does: a pre-compiled WebAssembly.Module on
// globalThis.__nimbusSqliteWasmModule, then synchronous DatabaseSync/
// StatementSync use — the engine boots lazily and synchronously on the
// first open (there is no eager boot step to await).
//
// WebAssembly.compile(bytes) is allowed here (Node/bun) — it is only
// blocked at facet REQUEST time in workerd, which is exactly why the facet
// path feeds the Module through the Worker Loader module map. The shim's
// instantiateWasm hook (WebAssembly.Instance(module, imports)) is the same
// in both environments.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { posix } from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { generateSqliteShimCode, generateSqliteFacetPreamble } from '../../packages/worker/src/runtime/sqlite-shim.ts';
import {
  SQLJS_VERSION,
} from '../../packages/core/src/constants.ts';

const require = createRequire(import.meta.url);

// Staged wasm asset (bundle-sqlite-wasm.mjs output). Compile it to a
// WebAssembly.Module exactly as the facet receives it from the module map.
const wasmPath = require.resolve(`../../packages/worker/public/_assets/sqljs-${SQLJS_VERSION}.wasm`);
const wasmBytes = readFileSync(wasmPath);
const wasmModule = await WebAssembly.compile(wasmBytes);

// Build a fresh shim sandbox. __fsMod mirrors the process's node:fs the shim
// closes over: `files` (path -> bytes) is its filesystem, `writes` what it
// was asked to write. __pathMod resolves against /home/user, the process's
// cwd; __cryptoMod is node:crypto.
function makeSandbox(files = new Map()) {
  // The shim attaches __nimbusSQL (first open) and __nimbusInitSqlite
  // (eager-boot API) to globalThis; reset between sandboxes so each test
  // boots its own engine state.
  delete globalThis.__nimbusSQL;
  delete globalThis.__nimbusInitSqlite;
  globalThis.__nimbusSqliteWasmModule = wasmModule;

  // Module-init preamble: prepares globalThis.__nimbusSqlJsFactory via
  // `new Function` (the facet runs this at module-eval time; the
  // request-time boot must not, because workerd blocks codegen there).
  new Function('globalThis', generateSqliteFacetPreamble())(globalThis);

  const code = generateSqliteShimCode();
  const writes = [];
  const fs = {
    readFileSync(path) {
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
      return files.get(path);
    },
    writeFileSync(path, bytes) {
      writes.push(path);
      files.set(path, bytes);
    },
  };
  const factory = new Function(
    'globalThis', '__fsMod', '__pathMod', '__cryptoMod',
    '"use strict";' + code + '\n;return { sqlite: __sqliteMod };',
  );
  const path = { resolve: (p) => posix.resolve('/home/user', p) };
  const sandbox = factory(globalThis, fs, path, crypto);
  return { sqlite: sandbox.sqlite, files, writes };
}

// ── Boot + in-memory CRUD, prepared statements, .all/.get/.run ──────────
{
  const { sqlite } = makeSandbox();
  const { DatabaseSync } = sqlite;

  // Lazy boot contract: creating the sandbox must NOT boot the engine —
  // the ~48 MiB engine boot is deferred until a DB is actually opened
  // (processes that never open one, e.g. the attach TUI client, never pay).
  assert.equal(globalThis.__nimbusSQL, undefined, 'engine must not boot before first open');

  const db = new DatabaseSync(':memory:');
  assert.ok(globalThis.__nimbusSQL, 'first open boots the engine synchronously');
  assert.equal(db.isOpen, true);

  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');

  // .run() returns { changes, lastInsertRowid }
  const insert = db.prepare('INSERT INTO users (name, age) VALUES (?, ?)');
  const r1 = insert.run('alice', 30);
  assert.equal(r1.changes, 1);
  assert.equal(r1.lastInsertRowid, 1);
  const r2 = insert.run('bob', 25);
  assert.equal(r2.lastInsertRowid, 2);
  insert.run('carol', 40);

  // .all() returns row-objects
  const all = db.prepare('SELECT * FROM users ORDER BY id').all();
  assert.equal(all.length, 3);
  assert.deepEqual(all[0], { id: 1, name: 'alice', age: 30 });
  assert.deepEqual(all[2], { id: 3, name: 'carol', age: 40 });

  // .get() returns a single row-object (or undefined)
  const one = db.prepare('SELECT * FROM users WHERE name = ?').get('bob');
  assert.deepEqual(one, { id: 2, name: 'bob', age: 25 });
  const none = db.prepare('SELECT * FROM users WHERE name = ?').get('nobody');
  assert.equal(none, undefined);

  // Parameter binding (positional) and a filtered aggregate.
  const count = db.prepare('SELECT COUNT(*) AS c FROM users WHERE age >= ?').get(30);
  assert.equal(count.c, 2);

  db.close();
  assert.equal(db.isOpen, false);
  console.log('ok: in-memory CRUD + prepared statements');
}

// ── Named parameters ────────────────────────────────────────────────────
{
  const { sqlite } = makeSandbox();
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (k TEXT, v INTEGER)');
  db.prepare('INSERT INTO t (k, v) VALUES (:k, :v)').run({ k: 'x', v: 7 });
  // bare name (no prefix) must also bind
  db.prepare('INSERT INTO t (k, v) VALUES (:k, :v)').run({ ':k': 'y', v: 9 });
  const rows = db.prepare('SELECT * FROM t ORDER BY v').all();
  assert.deepEqual(rows, [{ k: 'x', v: 7 }, { k: 'y', v: 9 }]);
  db.close();
  console.log('ok: named parameters');
}

// ── setReturnArrays + setReadBigInts ────────────────────────────────────
{
  const { sqlite } = makeSandbox();
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id INTEGER, label TEXT)');
  db.prepare('INSERT INTO t VALUES (?, ?)').run(100, 'hundred');

  const arr = db.prepare('SELECT id, label FROM t');
  arr.setReturnArrays(true);
  assert.deepEqual(arr.all(), [[100, 'hundred']]);

  const big = db.prepare('SELECT id FROM t');
  big.setReadBigInts(true);
  const row = big.get();
  assert.equal(typeof row.id, 'bigint');
  assert.equal(row.id, 100n);

  // setReadBigInts also affects run() change/rowid counters.
  const ins = db.prepare('INSERT INTO t VALUES (?, ?)');
  ins.setReadBigInts(true);
  const res = ins.run(2, 'two');
  assert.equal(typeof res.changes, 'bigint');
  assert.equal(typeof res.lastInsertRowid, 'bigint');

  db.close();
  console.log('ok: setReturnArrays + setReadBigInts');
}

// ── File-backed: open reads the file, close writes it when it changed ───
{
  const { sqlite, files, writes } = makeSandbox();
  const db = new sqlite.DatabaseSync('/home/user/app.db');
  db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO kv VALUES (?, ?)').run('hello', 'world');
  db.close();
  assert.deepEqual(writes, ['/home/user/app.db'], 'close() wrote the database to its file');
  assert.ok(files.get('/home/user/app.db') instanceof Uint8Array && files.get('/home/user/app.db').length > 0);

  // A later connection (here a fresh sandbox over the same files) reads it.
  const reopened = makeSandbox(files);
  const db2 = new reopened.sqlite.DatabaseSync('/home/user/app.db');
  assert.deepEqual(db2.prepare('SELECT v FROM kv WHERE k = ?').get('hello'), { v: 'world' });
  assert.deepEqual(db2.prepare("INSERT INTO kv VALUES ('a', 'b') RETURNING k").all(), [{ k: 'a' }]);
  db2.close();
  assert.deepEqual(reopened.writes, ['/home/user/app.db'], "a row method's write is written back");

  const readOnly = makeSandbox(files);
  const db3 = new readOnly.sqlite.DatabaseSync('/home/user/app.db');
  assert.equal(db3.prepare('SELECT count(*) AS n FROM kv').get().n, 2);
  db3.close();
  assert.deepEqual(readOnly.writes, [], 'a database only read is not written back');
  console.log('ok: file-backed persistence (written on close when changed, read on open)');
}

// ── Unsupported methods throw a clear error; never fake ─────────────────
{
  const { sqlite } = makeSandbox();
  const db = new sqlite.DatabaseSync(':memory:');
  assert.throws(() => db.loadExtension('x'), /node:sqlite: .* not supported/);
  assert.throws(() => db.function('f'), /node:sqlite: .* not supported/);
  assert.throws(() => db.aggregate('a'), /node:sqlite: .* not supported/);
  db.exec('CREATE TABLE t (a)');
  const stmt = db.prepare('SELECT * FROM t');
  assert.throws(() => stmt.iterate(), /node:sqlite: .* not supported/);
  assert.throws(() => stmt.columns(), /node:sqlite: .* not supported/);
  db.close();
  console.log('ok: unsupported methods throw clear errors');
}

// ── Eager boot API (__nimbusInitSqlite): for callers that will open a DB ─
{
  makeSandbox();
  assert.equal(globalThis.__nimbusSQL, undefined, 'engine must not boot at shim eval');
  const SQL = await globalThis.__nimbusInitSqlite();
  assert.ok(globalThis.__nimbusSQL, 'eager boot instantiates the engine');
  assert.equal(typeof SQL.Database, 'function');
  console.log('ok: eager boot API');
}

// Clean up the globals we set so we don't leak into a shared bun process.
delete globalThis.__nimbusSQL;
delete globalThis.__nimbusInitSqlite;
delete globalThis.__nimbusSqliteWasmModule;
delete globalThis.__nimbusSqlJsFactory;

console.log('\nALL node:sqlite shim unit tests passed');
