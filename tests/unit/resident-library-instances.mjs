#!/usr/bin/env bun
// One evaluation of the staged library, two differently backed processes.
// No module reload or fresh realm can accidentally provide their isolation.
import assert from 'node:assert/strict';
import { positionOf, rootOf } from '../../packages/core/src/runtime/feed-position.ts';
import './lib/launch-captures.mjs';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { facetStorage } from './lib/fake-do-kv.mjs';
import { facetSql } from './lib/resident-body.mjs';

const text = nodeFacetSources('').residentStore;
const library = /** @type {typeof import('../../packages/worker/src/vfs/resident/index.ts')} */ (
  new Function(text + '\nreturn __nimbusResidentModule;')()
);
const sql = facetSql();
const facetReads = new Set();
const heapReads = new Set();
const facet = library.createResidentStore({ observeRead: (path) => facetReads.add(path) });
const heap = library.createResidentStore({ observeRead: (path) => heapReads.add(path) });

try {
  facet.bind({ storage: facetStorage(sql) });
  heap.bindInMemory(1024 * 1024);
  facet.namespace.setCred({ uid: 1000, gid: 1000, groups: [1000] });
  heap.namespace.setCred({ uid: 2000, gid: 2000, groups: [2000] });
  const facetCursor = positionOf('', { '/': { epoch: 'facet-session', cursor: 11 } });
  const heapCursor = positionOf('', { '/': { epoch: 'heap-session', cursor: 73 } });
  facet.cells.admit({ position: facetCursor, poison: false, paths: [] });
  heap.cells.admit({ position: heapCursor, poison: false, paths: [] });
  assert.deepEqual(facet.coherence.cursor(), facetCursor);
  assert.deepEqual(heap.coherence.cursor(), heapCursor);

  const emptyHeap = heap.cells.stats();
  assert.equal(facet.cells.fill('facet-only.txt', 'FACET', rootOf(facetCursor).cursor), true);
  assert.deepEqual(heap.cells.stats(), emptyHeap, 'a facet-backed fill cannot charge the heap process');
  assert.equal('facet-only.txt' in heap.bundle, false);
  assert.equal(heap.bundle['facet-only.txt'], undefined, 'the other process cannot read the fill');
  const filledFacet = facet.cells.stats();
  assert.equal(heap.cells.fill('heap-only.txt', 'HEAP!', rootOf(heapCursor).cursor), true);
  assert.deepEqual(facet.cells.stats(), filledFacet, 'a heap fill cannot charge the facet-backed process');
  assert.equal('heap-only.txt' in facet.bundle, false);
  assert.equal(facet.bundle['heap-only.txt'], undefined);

  const secret = { mode: 0o100600, uid: 1000, gid: 1000 };
  assert.equal(facet.namespace.readable(secret), true);
  assert.equal(heap.namespace.readable(secret), false, 'the last credential set must not replace another store\'s credential');
  const otherSecret = { ...secret, uid: 2000, gid: 2000 };
  assert.equal(facet.namespace.readable(otherSecret), false);
  assert.equal(heap.namespace.readable(otherSecret), true);

  facetReads.clear();
  heapReads.clear();
  assert.equal(facet.bundle['facet-only.txt'], 'FACET');
  assert.deepEqual([...facetReads], ['facet-only.txt']);
  assert.deepEqual([...heapReads], [], 'the facet-backed process\'s reads do not strike the heap read profile');
  assert.equal(heap.bundle['heap-only.txt'], 'HEAP!');
  assert.deepEqual([...facetReads], ['facet-only.txt']);
  assert.deepEqual([...heapReads], ['heap-only.txt']);
  assert.equal(facet.cells.stats().files, 1);
  assert.equal(facet.cells.stats().bytes, 5);
  assert.equal(heap.cells.stats().files, 1);
  assert.equal(heap.cells.stats().bytes, 5);

  facet.cells.admit({ position: positionOf('', { '/': { epoch: 'facet-next-incarnation', cursor: 0 } }), poison: true, paths: [] });
  assert.deepEqual(heap.coherence.cursor(), heapCursor, 'a poison in one process cannot advance or seal its neighbour');
  assert.equal(heap.bundle['heap-only.txt'], 'HEAP!');
  assert.equal(facet.cells.stats().files, 0);
  assert.equal(heap.cells.stats().files, 1);
  heap.cells.clear();
  assert.equal(heap.coherence.cursor(), null);
  assert.deepEqual(facet.coherence.cursor(), positionOf('', { '/': { epoch: 'facet-next-incarnation', cursor: 0 } }));
} finally {
  sql.db.close();
}
console.log('resident-library-instances: PASS');
