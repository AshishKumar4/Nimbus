#!/usr/bin/env bun
/**
 * wasi-resident-fs-kept-store — a WASI process run in a warm facet (one the
 * last process of it left, FacetSpec.warm) continues the resident store that
 * process left, through the real WASI body and resident filesystem, in one
 * session:
 *
 *   - the next process of the same credential reads what the first one read
 *     (a big file's pages, a small file's bytes) without asking the session;
 *   - a file that changed between the two is not served from the kept store:
 *     the next process's first answer takes the barrier from the store's
 *     cursor, which drops it, and the new bytes are read;
 *   - a process of another credential, or in a facet of its own, keeps
 *     nothing of it; nor does the next process after a run whose writes
 *     were not all answered.
 */

import assert from 'node:assert/strict';
import { canPark, residentGuest, USER } from './lib/wasi-resident-guest.mjs';
import { RESIDENT_PAGE_BYTES } from '../../packages/platform/src/limits.ts';
import { WASI_RESIDENT_FILE_CAP_BYTES } from '../../packages/core/src/constants.ts';

if (!canPark) {
  console.log('wasi-resident-fs-kept-store: SKIPPED (this engine has no JSPI, so a guest answers from the session)');
  process.exit(0);
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

const first = await residentGuest();
const { kernel } = first;
kernel.writeFile('home/user/pack.bin', big, { mode: 0o644 });
kernel.chown('home/user/pack.bin', USER.uid, USER.gid);
kernel.writeFile('home/user/notes.txt', 'one', { mode: 0o644 });
kernel.chown('home/user/notes.txt', USER.uid, USER.gid);

const a = await run(first);
assert.deepEqual(a.range, big.slice(3 * RESIDENT_PAGE_BYTES + 5, 5 * RESIDENT_PAGE_BYTES + 5));
assert.equal(a.text, 'one');
assert.equal(a.stats.pagesFetched, 3, 'the first process reads the pages from the session');
await first.end();

const second = await residentGuest({ after: first });
const b = await run(second);
assert.deepEqual(b.range, a.range);
assert.equal(b.stats.pagesFetched, 0, 'the next process in the same facet reads them from the store the first one left');
assert.equal(b.stats.fills, 0, 'and the small file too');
assert.equal(b.text, 'one');
await second.end();

kernel.writeFile('home/user/notes.txt', 'two!', { mode: 0o644 });
const third = await residentGuest({ after: second });
const c = await run(third);
assert.equal(c.text, 'two!', 'a file changed since is read anew, not served from the kept store');
assert.equal(c.stats.pagesFetched, 0, 'the big file did not change: its pages still serve');
await third.end();

const other = await residentGuest({ after: third, cred: { uid: 1001, gid: 1001, groups: [1001], umask: 0o022 } });
const d = await run(other);
assert.equal(d.stats.pagesFetched, 3, "another credential's process keeps nothing of the store");
await other.end();

const elsewhere = await residentGuest({ of: first });
assert.equal((await run(elsewhere)).stats.pagesFetched, 3, 'a process in a facet of its own keeps nothing');

await elsewhere.dispose();

// A run whose writes were refused leaves nothing to the next one.
const refusing = await residentGuest({ refuse: (path) => path.endsWith('refused.txt') });
refusing.kernel.writeFile('home/user/pack.bin', big, { mode: 0o644 });
refusing.kernel.chown('home/user/pack.bin', USER.uid, USER.gid);
refusing.kernel.writeFile('home/user/notes.txt', 'one', { mode: 0o644 });
refusing.kernel.chown('home/user/notes.txt', USER.uid, USER.gid);
assert.equal((await run(refusing)).stats.pagesFetched, 3);
const fdRefused = await refusing.open('home/user/refused.txt', { create: true, write: true, truncate: true });
await refusing.write(fdRefused, 'not stored');
await refusing.close(fdRefused);
assert.notEqual(await refusing.end(), null, 'the run reports the write the session refused');
const afterRefused = await residentGuest({ after: refusing });
assert.equal((await run(afterRefused)).stats.pagesFetched, 3, 'and the next process in its facet starts afresh');
await afterRefused.dispose();
console.log('wasi-resident-fs-kept-store: ok');
