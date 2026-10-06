#!/usr/bin/env bun
/**
 * wasi-resident-fs-kept-store — a WASI process whose store is its facet's
 * SQLite (a named one-shot's, __wasiAdoptStorage) leaves it to the next
 * process of the same name, through the real WASI body and resident
 * filesystem, in one session:
 *
 *   - the next process resumes from the store's cursor: the pages the first
 *     read of a big file are read again without asking the session;
 *   - a file that changed between the two is not served from the kept store:
 *     the delta from the cursor dropped it, and the new bytes are read;
 *   - a process without storage (a one-shot's heap) keeps nothing.
 */

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { canPark, residentGuest, USER } from './lib/wasi-resident-guest.mjs';
import { RESIDENT_PAGE_BYTES } from '../../packages/platform/src/limits.ts';
import { WASI_RESIDENT_FILE_CAP_BYTES } from '../../packages/core/src/constants.ts';

if (!canPark) {
  console.log('wasi-resident-fs-kept-store: SKIPPED (this engine has no JSPI, so a guest answers from the session)');
  process.exit(0);
}

/** workerd's ctx.storage.sql over a real SQLite: exec(query, ...params) → rows. */
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

const SIZE = WASI_RESIDENT_FILE_CAP_BYTES + 2 * RESIDENT_PAGE_BYTES;
const big = Uint8Array.from({ length: SIZE }, (_, i) => (i * 7 + 3) & 0xff);
const IOV = 12288, OUT = 12300, AT = 1 << 21;

/** fd_pread through `guest`: the bytes. */
async function pread(guest, fd, offset, length) {
  const { memory, wasiImport } = guest;
  while (memory.buffer.byteLength < AT + length) memory.grow(Math.ceil((AT + length - memory.buffer.byteLength) / 65536));
  const view = new DataView(memory.buffer);
  view.setUint32(IOV, AT, true);
  view.setUint32(IOV + 4, length, true);
  assert.equal(await wasiImport.fd_pread(fd, IOV, 1, BigInt(offset), OUT), 0);
  return new Uint8Array(memory.buffer.slice(AT, AT + new DataView(memory.buffer).getUint32(OUT, true)));
}

/** A process that reads the big file's range and the small file whole, and ends. */
async function run(guest) {
  const fd = await guest.open('home/user/pack.bin');
  const range = await pread(guest, fd, 3 * RESIDENT_PAGE_BYTES + 5, 2 * RESIDENT_PAGE_BYTES);
  await guest.close(fd);
  const small = await guest.open('home/user/notes.txt');
  const text = await guest.pread(small, 64);
  await guest.close(small);
  return { range, text, stats: guest.stats() };
}

const storage = sqlShim();
const first = await residentGuest({ storage });
const { kernel } = first;
kernel.writeFile('home/user/pack.bin', big, { mode: 0o644 });
kernel.chown('home/user/pack.bin', USER.uid, USER.gid);
kernel.writeFile('home/user/notes.txt', 'one', { mode: 0o644 });
kernel.chown('home/user/notes.txt', USER.uid, USER.gid);

const a = await run(first);
assert.deepEqual(a.range, big.slice(3 * RESIDENT_PAGE_BYTES + 5, 5 * RESIDENT_PAGE_BYTES + 5));
assert.equal(a.text, 'one');
assert.equal(a.stats.pagesFetched, 3, 'the first process reads the pages from the session');

const second = await residentGuest({ storage, world: first.world });
const b = await run(second);
assert.deepEqual(b.range, a.range);
assert.equal(b.stats.pagesFetched, 0, 'the next process of the same storage reads them from it');
assert.equal(b.text, 'one');

kernel.writeFile('home/user/notes.txt', 'two!', { mode: 0o644 });
const third = await residentGuest({ storage, world: first.world });
const c = await run(third);
assert.equal(c.text, 'two!', 'a file changed since is read anew, not served from the kept store');
assert.equal(c.stats.pagesFetched, 0, 'the big file did not change: its pages still serve');

const heap = await residentGuest({ world: first.world });
assert.equal((await run(heap)).stats.pagesFetched, 3, 'a one-shot\'s heap keeps nothing');

await heap.dispose();
await third.dispose();
await second.dispose();
await first.dispose();
console.log('wasi-resident-fs-kept-store: ok');
