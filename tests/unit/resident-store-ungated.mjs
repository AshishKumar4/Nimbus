#!/usr/bin/env bun
// A long-running process's store writes nothing its facet's output gate
// holds. A turn that writes SQL holds the process's next outbound message
// until the write is confirmed: 23-36 ms measured on every turn a fill wrote
// rows (verify/consolidation/file-engine-d4-measurements.md). The store's
// rows are in the facet's key-value storage, put unconfirmed (the fake
// refuses any other write), and read synchronously: its SQL holds none of
// them. A store kept in SQL tables by an earlier Nimbus is dropped when the
// store binds, so its bytes are not counted against the process's room.

import assert from 'node:assert/strict';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { facetSql } from './lib/resident-body.mjs';
import { facetStorage } from './lib/fake-do-kv.mjs';

const sql = facetSql();
// What an earlier Nimbus left: its store in the facet's SQL.
for (const table of ['file', 'chunk', 'ns', 'meta', 'page']) sql.exec(`CREATE TABLE ${table} (k TEXT PRIMARY KEY, v BLOB)`);
sql.exec("INSERT INTO chunk (k, v) VALUES ('home/user/old.bin', ?)", new Uint8Array(200_000));
const before = Number(sql.exec('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()')[0].n);

// Its SQL writes once the store is bound: dropping what an earlier Nimbus left is the bind's, once.
const writes = [];
let bound = false;
const recorded = {
  db: sql.db,
  exec(query, ...params) {
    if (bound && /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)/i.test(query)) writes.push(query.trim().replace(/\s+/g, ' ').slice(0, 60));
    return sql.exec(query, ...params);
  },
};
const storage = facetStorage(recorded);

const store = createResidentStore();
store.bind({ storage });
bound = true;
store.cells.admit({ poison: false, paths: [], epoch: 'e1', rev: 7 });
store.cells.fill('home/user/app/a.js', 'module.exports = 1;\n', 7);
store.cells.fill('home/user/app/b.bin', new Uint8Array(300_000).fill(9), 7);
store.bundle['home/user/app/own.txt'] = 'mine';

assert.deepEqual(writes, [], 'the store wrote nothing to SQL, where every write holds the next outbound message');
assert.ok(storage.writes > 0, 'its rows are in the key-value storage, put unconfirmed');
assert.equal(store.bundle['home/user/app/a.js'], 'module.exports = 1;\n', 'and read back from there');
assert.deepEqual(store.bundle['home/user/app/b.bin'], new Uint8Array(300_000).fill(9));
assert.equal(store.bundle['home/user/app/own.txt'], 'mine');

const left = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('file', 'chunk', 'ns', 'meta', 'page')").map((row) => row.name);
assert.deepEqual(left, [], 'an earlier Nimbus\'s store tables are dropped at bind');
sql.exec('VACUUM');
const after = Number(sql.exec('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()')[0].n);
assert.ok(after < before - 150_000, `with their bytes: ${before} before, ${after} after`);

console.log('resident-store-ungated: ok');
