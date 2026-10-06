#!/usr/bin/env bun
/**
 * wasi-resident-fs-pages — a WASI guest's positional reads of a file too big
 * to hold whole (a pack, a deep history's .idx), through the real WASI body,
 * the resident filesystem and the store's pages:
 *
 *   - the first pread of a range asks the session for its pages, once; a
 *     pread of the same range again, or of a part of it, asks nothing;
 *   - the bytes are the file's, across page boundaries and at its end;
 *   - a file replaced under its name (git's rename over): a page the open
 *     descriptor has not read is refused at the old revision, and once the
 *     process has learned of the change no held page is served either; the
 *     descriptor then reads what the session's descriptor reads (the file it
 *     opened), and a new open reads the new file's pages.
 */

import assert from 'node:assert/strict';
import { canPark, residentGuest, USER } from './lib/wasi-resident-guest.mjs';
import { RESIDENT_PAGE_BYTES } from '../../packages/platform/src/limits.ts';
import { WASI_RESIDENT_FILE_CAP_BYTES } from '../../packages/core/src/constants.ts';

if (!canPark) {
  console.log('wasi-resident-fs-pages: SKIPPED (this engine has no JSPI, so a guest answers from the session)');
  process.exit(0);
}

const SIZE = WASI_RESIDENT_FILE_CAP_BYTES + 3 * RESIDENT_PAGE_BYTES + 17;
const content = (seed) => Uint8Array.from({ length: SIZE }, (_, i) => (i * 31 + seed) & 0xff);
const guest = await residentGuest();
const { kernel, wasiImport, memory } = guest;
const view = () => new DataView(memory.buffer);
const IOV = 12288, OUT = 12300, AT = 1 << 21;

/** fd_pread of `length` bytes at `offset`: the bytes. */
async function pread(fd, offset, length) {
  while (memory.buffer.byteLength < AT + length) memory.grow(Math.ceil((AT + length - memory.buffer.byteLength) / 65536));
  view().setUint32(IOV, AT, true);
  view().setUint32(IOV + 4, length, true);
  const errno = await wasiImport.fd_pread(fd, IOV, 1, BigInt(offset), OUT);
  assert.equal(errno, 0, `fd_pread errno ${errno}`);
  return new Uint8Array(memory.buffer.slice(AT, AT + view().getUint32(OUT, true)));
}

const first = content(1);
kernel.writeFile('home/user/pack.bin', first, { mode: 0o644 });
kernel.chown('home/user/pack.bin', USER.uid, USER.gid);
const fd = await guest.open('home/user/pack.bin');

const before = guest.stats();
const start = RESIDENT_PAGE_BYTES * 5 - 100;
assert.deepEqual(await pread(fd, start, 3 * RESIDENT_PAGE_BYTES), first.slice(start, start + 3 * RESIDENT_PAGE_BYTES), 'across page boundaries');
const once = guest.stats();
assert.equal(once.pagedReads - before.pagedReads, 1);
assert.equal(once.pagesFetched - before.pagesFetched, 4, 'the four pages the range touches, asked for once');
assert.equal(once.delegated.read ?? 0, before.delegated.read ?? 0, 'no read of the descriptor');

assert.deepEqual(await pread(fd, start + 10, 1000), first.slice(start + 10, start + 1010));
assert.deepEqual(await pread(fd, start, 3 * RESIDENT_PAGE_BYTES), first.slice(start, start + 3 * RESIDENT_PAGE_BYTES));
const twice = guest.stats();
assert.equal(twice.pagesFetched, once.pagesFetched, 'held pages are not asked for again');
assert.equal(twice.pagedReads - once.pagedReads, 2);

assert.deepEqual(await pread(fd, SIZE - 50, 4096), first.slice(SIZE - 50), 'the end of the file');

// Replaced under its name, as git renames a new pack over.
const second = content(2);
kernel.writeFile('home/user/pack.tmp', second, { mode: 0o644 });
kernel.chown('home/user/pack.tmp', USER.uid, USER.gid);
kernel.rename('home/user/pack.tmp', 'home/user/pack.bin');
const middle = RESIDENT_PAGE_BYTES * 9;
let was = guest.stats();
assert.deepEqual(await pread(fd, middle, 100), first.slice(middle, middle + 100), 'a page not held: refused at the old revision, read through the descriptor');
let now = guest.stats();
assert.equal(now.pagedReads, was.pagedReads);
assert.equal((now.delegated.read ?? 0) - (was.delegated.read ?? 0), 1);
// Learned at the process's next barrier, here owed by a change of its own.
assert.equal(await guest.mkdir('home/user/learn'), 0);
was = guest.stats();
assert.deepEqual(await pread(fd, start, 100), first.slice(start, start + 100), 'the descriptor reads the file it opened');
now = guest.stats();
assert.equal(now.pagedReads, was.pagedReads, 'not from held pages: the process knows the name moved on');
assert.equal((now.delegated.read ?? 0) - (was.delegated.read ?? 0), 1);
await guest.close(fd);
const fresh = await guest.open('home/user/pack.bin');
assert.deepEqual(await pread(fresh, middle, 100), second.slice(middle, middle + 100), 'a new open reads the new file');
await guest.close(fresh);

await guest.dispose();
console.log('wasi-resident-fs-pages: ok');
