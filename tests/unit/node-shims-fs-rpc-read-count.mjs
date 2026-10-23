#!/usr/bin/env bun
// The facet's supervisor fs READ round trips are what a program costs.
//
// Reads are the only fs RPC a program can issue thousands of in one lifetime
// — an async whole-file read costs one round trip per READ_STREAM_CHUNK_BYTES
// — so the count is what has to move when reads are batched, coalesced or
// pipelined. Without it, a change to how reads are issued can only be
// asserted, not measured.
//
// Asserts the count against the calls the session really receives: every
// read call that crosses to the session (a whole-file read, a ranged read, a
// descriptor's read, or a batch carrying a range) is one round trip, and
// metadata must not inflate it.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { sessionShims } from './lib/session-shims.mjs';

const CHUNK = 65536; // READ_STREAM_CHUNK_BYTES

const dir = '/home/user/counted';
const authority = createAuthority();
authority.kfs.mkdir(dir.slice(1), { recursive: true, mode: 0o755 });
// Small enough for one round trip, and large enough for several.
authority.kfs.writeFile(`${dir.slice(1)}/small.txt`, 'x'.repeat(10));
authority.kfs.writeFile(`${dir.slice(1)}/big.bin`, new Uint8Array(3 * CHUNK).fill(7));
// A directory this process owns, declared to its view, so it may write.
authority.kfs.mkdir('home/user/mine', { recursive: true, mode: 0o755 });

// Every call that actually crosses to the session, by name; and the kinds of each batch's requests.
const crossed = { readFileBytes: 0, fsReadRange: 0, fsRead: 0, stat: 0, readdir: 0, fsAcquire: 0 };
const batches = [];
const { fs } = sessionShims(authority, {
  cwd: dir,
  overrides: (call) => {
    const counting = (name) => (...args) => { crossed[name]++; return call(name, args); };
    return {
      readFileBytes: counting('readFileBytes'),
      fsReadRange: counting('fsReadRange'),
      fsRead: counting('fsRead'),
      stat: counting('stat'),
      readdir: counting('readdir'),
      fsAcquire: counting('fsAcquire'),
      fsReadBatch: (requests) => {
        batches.push(requests.map((request) => (request.lstat === true ? 'lstat' : 'range')));
        return call('fsReadBatch', [requests]);
      },
    };
  },
  tail: ';return { fs: __fsMod };',
});
const fsp = fs.promises;

/** The read round trips the session has been asked for: each read call, and each batch carrying a range. */
const readTrips = () => crossed.readFileBytes + crossed.fsReadRange + crossed.fsRead
  + batches.filter((kinds) => kinds.includes('range')).length;

// ── one small file ──────────────────────────────────────────────────────
{
  const before = readTrips();
  const text = await fsp.readFile(`${dir}/small.txt`, 'utf8');
  assert.equal(text, 'x'.repeat(10));
  assert.ok(readTrips() > before, 'a whole-file async read crossed to the session for no read');
}

// ── metadata must not inflate the read count ────────────────────────────
{
  const before = readTrips();
  await fsp.stat(`${dir}/small.txt`);
  await fsp.readdir(dir);
  assert.ok(crossed.stat + crossed.readdir + crossed.fsAcquire > 0, 'metadata calls did not cross');
  assert.equal(readTrips(), before,
    'stat/readdir inflated the read count — it must count reads only');
}

// ── chunking amplification is visible ───────────────────────────────────
// This is the number a batching/pipelining change has to move: one logical
// read of a 3-chunk file costs more than one round trip.
{
  const before = readTrips();
  const bytes = await fsp.readFile(`${dir}/big.bin`);
  assert.equal(bytes.byteLength, 3 * CHUNK);
  const roundTrips = readTrips() - before;
  assert.ok(roundTrips > 1,
    `a ${3 * CHUNK}-byte read should span multiple ${CHUNK}-byte round trips, saw ${roundTrips}`);
  console.log(`  one ${3 * CHUNK}-byte async read = ${roundTrips} supervisor round trips`);
}

// ── learns riding the read batch are metadata, not reads ─────────────────
// A batch carries both ranged reads and the lstat each async read then
// learns of a name the namespace does not hold yet. Only a batch carrying a
// range is a read round trip.
{
  authority.peer.writeFile(`${dir.slice(1)}/learned.txt`, 'learned bytes');
  const before = readTrips();
  const batchesBefore = batches.length;
  assert.equal(await fsp.readFile(`${dir}/learned.txt`, 'utf8'), 'learned bytes');
  const learned = batches.slice(batchesBefore);
  const rangeTrips = learned.filter((kinds) => kinds.includes('range')).length;
  assert.ok(learned.some((kinds) => kinds.includes('lstat')), `the read learned its name by a batch: ${JSON.stringify(learned)}`);
  assert.equal(readTrips() - before, rangeTrips, `a batch of learns counted as a read: ${JSON.stringify(learned)}`);

  const readsBeforeWrite = readTrips();
  const batchesBeforeWrite = batches.length;
  await fsp.writeFile('/home/user/mine/written.txt', 'w');
  // Its stat comes back with it, in its call's receipt: no learn at all.
  assert.equal(batches.length, batchesBeforeWrite, `an async write learned its stat by a round trip of its own: ${JSON.stringify(batches.slice(batchesBeforeWrite))}`);
  assert.equal(fs.statSync('/home/user/mine/written.txt').size, 1, 'the write\'s stat is what the process sees');
  assert.equal(readTrips(), readsBeforeWrite, 'an async write, which reads nothing, moved the read count');
}

console.log(`node-shims-fs-rpc-read-count OK: ${readTrips()} supervisor fs read round trips`);
