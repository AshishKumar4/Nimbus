#!/usr/bin/env bun
// runtime-pkg/node-sqlite — node:sqlite (sql.js-backed) inside a Nimbus
// Node facet: CREATE TABLE / INSERT / SELECT (.all/.get), a prepared
// statement with params, setReturnArrays, and reopen-after-close
// persistence across two separate `node` invocations.
//
// The wasm enters the facet via the Worker Loader module map (request-time
// WebAssembly.compile is blocked); the DB image persists by flushing
// db.export() to the live SqliteVFS on close and re-loading it from the
// next facet's startup snapshot. This is opencode blocker #1.

import { mintSession, deleteSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('runtime-pkg/node-sqlite');
console.log(`runtime-pkg/node-sqlite — ${process.env.BASE}`);

const DB_PATH = '/home/user/nimbus-sqlite-probe.db';

// Program 1: create the DB, exercise the full read/write matrix, close.
const writer = `
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(${JSON.stringify(DB_PATH)});
db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, weight INTEGER)');

const ins = db.prepare('INSERT INTO notes (title, weight) VALUES (?, ?)');
const r1 = ins.run('alpha', 10);
console.log('RUN_CHANGES=' + r1.changes);
console.log('RUN_ROWID=' + r1.lastInsertRowid);
ins.run('bravo', 20);
ins.run('charlie', 30);

// Named-parameter prepared statement.
db.prepare('INSERT INTO notes (title, weight) VALUES (:t, :w)').run({ t: 'delta', w: 40 });

const all = db.prepare('SELECT id, title, weight FROM notes ORDER BY id').all();
console.log('ALL_COUNT=' + all.length);
console.log('ALL_FIRST=' + JSON.stringify(all[0]));

const got = db.prepare('SELECT title FROM notes WHERE weight = ?').get(30);
console.log('GET_TITLE=' + got.title);

const heavy = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE weight >= ?').get(20);
console.log('HEAVY_COUNT=' + heavy.c);

const arrStmt = db.prepare('SELECT title, weight FROM notes ORDER BY id');
arrStmt.setReturnArrays(true);
console.log('ARRAY_ROW=' + JSON.stringify(arrStmt.all()[1]));

db.close();
console.log('WRITER_DONE');
`;

// Program 2: a SEPARATE node invocation (new facet) reopens the same path
// and proves the data persisted across close → live-VFS flush → reopen.
const reader = `
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(${JSON.stringify(DB_PATH)});
const rows = db.prepare('SELECT title FROM notes ORDER BY id').all();
console.log('REOPEN_COUNT=' + rows.length);
console.log('REOPEN_TITLES=' + rows.map((r) => r.title).join(','));

const d = db.prepare('SELECT weight FROM notes WHERE title = ?').get('delta');
console.log('REOPEN_DELTA_WEIGHT=' + d.weight);
db.close();
console.log('READER_DONE');
`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  await t.run(heredocCommand('sqlite-writer.mjs', writer), 10_000);
  await t.run(heredocCommand('sqlite-reader.mjs', reader), 10_000);

  const w = stripAnsi((await t.run('node sqlite-writer.mjs', 60_000)).output);

  a.check('node:sqlite import + open + CREATE TABLE succeed (writer completes)',
    /WRITER_DONE/.test(w), JSON.stringify(w.slice(-1200)));
  a.check('.run() reports changes=1',
    /RUN_CHANGES=1\b/.test(w), JSON.stringify(w.slice(-1200)));
  a.check('.run() reports lastInsertRowid=1',
    /RUN_ROWID=1\b/.test(w), JSON.stringify(w.slice(-1200)));
  a.check('.all() returns every inserted row (4)',
    /ALL_COUNT=4\b/.test(w), JSON.stringify(w.slice(-1200)));
  a.check('.all() returns row-objects',
    /ALL_FIRST=\{"id":1,"title":"alpha","weight":10\}/.test(w), JSON.stringify(w.slice(-1200)));
  a.check('.get() with a positional param returns the matching row',
    /GET_TITLE=charlie/.test(w), JSON.stringify(w.slice(-1200)));
  a.check('named-parameter prepared statement + aggregate query work',
    /HEAVY_COUNT=3\b/.test(w), JSON.stringify(w.slice(-1200)));
  a.check('setReturnArrays(true) returns positional arrays',
    /ARRAY_ROW=\["bravo",20\]/.test(w), JSON.stringify(w.slice(-1200)));

  const r = stripAnsi((await t.run('node sqlite-reader.mjs', 60_000)).output);

  a.check('reopen-after-close in a NEW facet sees the persisted rows (4)',
    /REOPEN_COUNT=4\b/.test(r), JSON.stringify(r.slice(-1200)));
  a.check('persisted rows survive the close→flush→reopen round-trip',
    /REOPEN_TITLES=alpha,bravo,charlie,delta/.test(r), JSON.stringify(r.slice(-1200)));
  a.check('named-parameter insert from the writer persisted',
    /REOPEN_DELTA_WEIGHT=40\b/.test(r), JSON.stringify(r.slice(-1200)));
  a.check('reader completes cleanly',
    /READER_DONE/.test(r), JSON.stringify(r.slice(-1200)));
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
