#!/usr/bin/env bun
// One evaluation of the staged library, two differently backed processes.
// No module reload or fresh realm can accidentally provide their isolation.
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import './lib/launch-captures.mjs';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';

const text = nodeFacetSources('').residentStore;
const library = /** @type {typeof import('../../packages/worker/src/vfs/resident/index.ts')} */ (
  new Function(text + '\nreturn __nimbusResidentModule;')()
);
const db = new Database(':memory:');
const sql = {
  exec(query, ...params) {
    if (/^\s*(CREATE|INSERT|UPDATE|DELETE|REPLACE)/i.test(query)) {
      db.query(query).run(...params);
      return [];
    }
    return db.query(query).all(...params);
  },
  get databaseSize() { return 0; },
};
const sqlReads = new Set();
const heapReads = new Set();
const sqlite = library.createResidentStore({ observeRead: (path) => sqlReads.add(path) });
const heap = library.createResidentStore({ observeRead: (path) => heapReads.add(path) });

try {
  sqlite.bind({ storage: { sql } });
  heap.bindInMemory(1024 * 1024);
  sqlite.namespace.setCred({ uid: 1000, gid: 1000, groups: [1000] });
  heap.namespace.setCred({ uid: 2000, gid: 2000, groups: [2000] });
  const sqlCursor = { epoch: 'sqlite-session', rev: 11 };
  const heapCursor = { epoch: 'heap-session', rev: 73 };
  sqlite.cells.admit({ ...sqlCursor, poison: false, paths: [] });
  heap.cells.admit({ ...heapCursor, poison: false, paths: [] });
  assert.deepEqual(sqlite.coherence.cursor(), sqlCursor);
  assert.deepEqual(heap.coherence.cursor(), heapCursor);

  const emptyHeap = heap.cells.stats();
  assert.equal(sqlite.cells.fill('sql-only.txt', 'SQL', sqlCursor.rev), true);
  assert.deepEqual(heap.cells.stats(), emptyHeap, 'a SQLite fill cannot charge the heap process');
  assert.equal('sql-only.txt' in heap.bundle, false);
  assert.equal(heap.bundle['sql-only.txt'], undefined, 'the other process cannot read the fill');
  const filledSql = sqlite.cells.stats();
  assert.equal(heap.cells.fill('heap-only.txt', 'HEAP!', heapCursor.rev), true);
  assert.deepEqual(sqlite.cells.stats(), filledSql, 'a heap fill cannot charge the SQLite process');
  assert.equal('heap-only.txt' in sqlite.bundle, false);
  assert.equal(sqlite.bundle['heap-only.txt'], undefined);

  const secret = { mode: 0o100600, uid: 1000, gid: 1000 };
  assert.equal(sqlite.namespace.readable(secret), true);
  assert.equal(heap.namespace.readable(secret), false, 'the last credential set must not replace another store\'s credential');
  const otherSecret = { ...secret, uid: 2000, gid: 2000 };
  assert.equal(sqlite.namespace.readable(otherSecret), false);
  assert.equal(heap.namespace.readable(otherSecret), true);

  sqlReads.clear();
  heapReads.clear();
  assert.equal(sqlite.bundle['sql-only.txt'], 'SQL');
  assert.deepEqual([...sqlReads], ['sql-only.txt']);
  assert.deepEqual([...heapReads], [], 'SQLite reads do not strike the heap read profile');
  assert.equal(heap.bundle['heap-only.txt'], 'HEAP!');
  assert.deepEqual([...sqlReads], ['sql-only.txt']);
  assert.deepEqual([...heapReads], ['heap-only.txt']);
  assert.equal(sqlite.cells.stats().files, 1);
  assert.equal(sqlite.cells.stats().bytes, 3);
  assert.equal(heap.cells.stats().files, 1);
  assert.equal(heap.cells.stats().bytes, 5);

  sqlite.cells.admit({ epoch: 'sqlite-next-incarnation', rev: 0, poison: true, paths: [] });
  assert.deepEqual(heap.coherence.cursor(), heapCursor, 'a poison in one process cannot advance or seal its neighbour');
  assert.equal(heap.bundle['heap-only.txt'], 'HEAP!');
  assert.equal(sqlite.cells.stats().files, 0);
  assert.equal(heap.cells.stats().files, 1);
  heap.cells.clear();
  assert.equal(heap.coherence.cursor(), null);
  assert.deepEqual(sqlite.coherence.cursor(), { epoch: 'sqlite-next-incarnation', rev: 0 });
} finally {
  db.close();
}
console.log('resident-library-instances: PASS');
