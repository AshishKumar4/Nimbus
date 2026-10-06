#!/usr/bin/env bun
/**
 * resident-page-cache — the resident store's pages of files too big to hold
 * whole (worker vfs/facet-resident-store.ts __residentPages), on both
 * backings, over a session that answers fsReadBatch as the session does
 * (a range pinned to a revision the file has left is refused):
 *
 *   - a first read fetches the pages in one batch and holds them, at the
 *     revision they were read at; a second read of them asks nothing;
 *   - a read at a revision the file has left is refused (null), and a page
 *     of another revision is never served for it;
 *   - the pages held never pass RESIDENT_PAGE_CACHE_BYTES, half the store's
 *     cap, nor RESIDENT_PAGE_CACHE_FREE_SHARE of what they hold plus what
 *     the session's ledger says is still free, the least recently used out
 *     first;
 *   - a store that starts again from nothing (a new lazy boot) holds no page;
 *   - a kept store (SQLite an earlier process left) resumes with its pages
 *     for the same credential in the same epoch, and starts from nothing for
 *     another credential, another epoch, or a store whose stamp is gone.
 */

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import { RESIDENT_PAGE_BYTES, RESIDENT_PAGE_CACHE_BYTES, RESIDENT_PAGE_CACHE_FREE_SHARE } from '../../packages/platform/src/limits.ts';

const P = RESIDENT_PAGE_BYTES;
const API = 'bindInMemory: __residentBindInMemory, bindTables: __residentBindTables, onSql: __residentTablesOnSql, bootLazy: __residentBootLazy, resume: __residentResumeLazy,'
  + ' view: __residentNamespaceView, pageHeld: __residentPageHeld, setStorage: __residentSetStorage, tables: () => __residentT';
const freshStore = () => new Function(`${FACET_RESIDENT_STORE_SOURCE}\nreturn { ${API} };`)();

/** workerd's ctx.storage.sql over a real SQLite. */
function sqlShim() {
  const db = new Database(':memory:');
  return {
    exec(query, ...params) {
      if (/^\s*(CREATE|INSERT|UPDATE|DELETE|REPLACE|DROP)/i.test(query)) { db.query(query).run(...params); return []; }
      return db.query(query).all(...params);
    },
    get databaseSize() { return 0; },
  };
}

/** A session holding one file, `big`, at revision `rev`: ranges of it, pinned to a revision. */
function session(size) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 131 + 7) & 0xff);
  const s = {
    rev: 5,
    epoch: 'e1',
    batches: [],
    async fsAcquire() { return { epoch: s.epoch, rev: 100 }; },
    async fsReadBatch(requests) {
      s.batches.push(requests.length);
      return requests.map((r) => {
        if (r.path !== '/home/user/big') return { error: { code: 'ENOENT' } };
        if (r.expectedEpoch !== s.epoch || r.expectedRevision !== s.rev) return { error: { code: 'ESTALE', message: 'revision moved' } };
        return { bytes: bytes.slice(r.offset, r.offset + r.length) };
      });
    },
  };
  return { s, bytes };
}

const USER = { uid: 1000, gid: 1000, groups: [1000] };
const joined = (pages) => {
  const out = new Uint8Array(pages.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of pages) { out.set(p, at); at += p.byteLength; }
  return out;
};

for (const backing of ['heap', 'sqlite']) {
  const store = freshStore();
  if (backing === 'heap') store.bindInMemory(64 * P);
  else store.bindTables(store.onSql(sqlShim()));
  const size = 20 * P + 123;
  const { s, bytes } = session(size);
  store.setStorage(undefined, s);
  assert.equal(await store.bootLazy(s), true);
  const view = store.view(s, 1, USER);

  // A first read fetches, in one batch; a second asks nothing.
  const first = await view.pages('home/user/big', 5, size, 2, 5);
  assert.equal(first.fetched, 4, `${backing}: four pages read`);
  assert.deepEqual(s.batches, [4], `${backing}: in one batch`);
  assert.deepEqual(joined(first.pages), bytes.slice(2 * P, 6 * P), `${backing}: the bytes`);
  const again = await view.pages('home/user/big', 5, size, 3, 5);
  assert.equal(again.fetched, 0, `${backing}: held pages are not asked for again`);
  assert.deepEqual(s.batches, [4]);
  assert.deepEqual(joined(again.pages), bytes.slice(3 * P, 6 * P));
  const tail = await view.pages('home/user/big', 5, size, 20, 20);
  assert.equal(tail.pages[0].byteLength, 123, `${backing}: the last page is the file's end`);

  // The file moved on: a read at the old revision is refused, and the held
  // pages are another revision's, never served for the new one.
  s.rev = 6;
  assert.equal(await view.pages('home/user/big', 5, size, 7, 7), null, `${backing}: a revision the file left is refused`);
  const moved = await view.pages('home/user/big', 6, size, 3, 3);
  assert.equal(moved.fetched, 1, `${backing}: a page of the new revision is read, not the old one served`);

  // A new lazy boot starts from nothing: no page is held.
  assert.ok(store.pageHeld() > 0);
  assert.equal(await store.bootLazy(s), true);
  assert.equal(store.pageHeld(), 0, `${backing}: a fresh boot holds no page`);
  assert.equal((await view.pages('home/user/big', 6, size, 3, 3)).fetched, 1);
}

// The bound: half the store's cap (here a heap of 16 pages: 8 held at most),
// the least recently used out first.
{
  const store = freshStore();
  store.bindInMemory(16 * P + 64 * 1024);
  const size = 40 * P;
  const { s } = session(size);
  store.setStorage(undefined, s);
  await store.bootLazy(s);
  const view = store.view(s, 1, USER);
  for (let part = 0; part < 8; part++) await view.pages('home/user/big', 5, size, part, part);
  assert.equal((await view.pages('home/user/big', 5, size, 0, 0)).fetched, 0, 'page 0 is held, and now the most recently used');
  for (let part = 8; part < 12; part++) await view.pages('home/user/big', 5, size, part, part);
  assert.ok(store.pageHeld() <= 8 * P, `never past half the cap (${store.pageHeld()} bytes)`);
  assert.equal((await view.pages('home/user/big', 5, size, 0, 0)).fetched, 0, 'the page used last stayed');
  assert.equal((await view.pages('home/user/big', 5, size, 1, 1)).fetched, 1, 'the least recently used went first');
}

// A session nearly full: the ledger answers each grant with what is still
// free, and the pages keep to their share of it.
{
  const store = freshStore();
  store.bindTables(store.onSql(sqlShim()));
  const size = 40 * P;
  const { s } = session(size);
  const free = 8 * P;
  s.fsStorageGrant = async (_facet, want) => ({ granted: want, available: free });
  store.setStorage({ facet: 'wasi-git-0', grant: 0 }, s);
  await store.bootLazy(s);
  const view = store.view(s, 1, USER);
  for (let part = 0; part < 12; part++) await view.pages('home/user/big', 5, size, part, part);
  const held = store.pageHeld();
  assert.ok(held > 0, 'pages are held');
  assert.ok(held <= RESIDENT_PAGE_CACHE_FREE_SHARE * (held + free), `within their share of what is free (${held} bytes held, ${free} free)`);
}

// A kept store: the next process resumes with what the last one read.
{
  const sql = sqlShim();
  const size = 8 * P;
  const { s } = session(size);
  const firstProcess = freshStore();
  firstProcess.bindTables(firstProcess.onSql(sql));
  firstProcess.setStorage(undefined, s);
  assert.equal(await firstProcess.resume(s, USER), true, 'a store with no cursor boots fresh');
  assert.equal((await firstProcess.view(s, 1, USER).pages('home/user/big', 5, size, 0, 3)).fetched, 4);
  const next = async (cred, epoch = 'e1') => {
    s.epoch = epoch;
    const store = freshStore();
    store.bindTables(store.onSql(sql));
    store.setStorage(undefined, s);
    assert.equal(await store.resume(s, cred), true);
    return store;
  };
  const same = await next(USER);
  assert.equal((await same.view(s, 1, USER).pages('home/user/big', 5, size, 0, 3)).fetched, 0, 'the same credential resumes with the pages');
  const other = await next({ uid: 0, gid: 0, groups: [0] });
  assert.equal(other.pageHeld(), 0, 'another credential starts from nothing');
  await next(USER);
  const moved = await next(USER, 'e2');
  assert.equal(moved.pageHeld(), 0, 'another epoch starts from nothing');
}

assert.ok(RESIDENT_PAGE_CACHE_BYTES >= 64 * 1024 * 1024, 'the bound holds a deep history\'s index');
console.log('resident-page-cache: ok');
