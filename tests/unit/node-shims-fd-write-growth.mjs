#!/usr/bin/env bun
// A descriptor write loop must cost O(total bytes), not O(total bytes²).
//
// Every fd-style write is decided into the process's held writes, which the
// process grows in place. Rebuilding that whole buffer per call means write N
// of a loop copies everything written so far, so appending a file in chunks
// moves ~N²/2 chunks of memory: a 26 MiB write loop moved gigabytes and OOM'd
// the facet.
//
// The assertion is on data movement rather than wall time — it is the thing
// that actually blew up, and it is deterministic. Uint8Array.prototype.set is
// how every copy in that path is made, so counting the bytes it moves during
// the loop measures the cost directly.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { sessionShims } from './lib/session-shims.mjs';

const CHUNK = 4096;
const WRITES = 512;
const TOTAL = CHUNK * WRITES;

/** A process of its own on a new session, its working directory its home. */
function processShims() {
  return sessionShims(createAuthority(), { cwd: '/home/user', tail: ';return { fs: __fsMod, Buffer: __BufferMod };' });
}

/** Writes `count` chunks of `CHUNK` bytes to a new file, counting the bytes copied while it writes. */
function writeLoop(path, count) {
  const { fs, Buffer } = processShims();
  const fd = fs.openSync(path, 'w');
  const chunk = Buffer.alloc(CHUNK, 0x41);

  const origSet = Uint8Array.prototype.set;
  let copied = 0;
  Uint8Array.prototype.set = function (src, offset) {
    copied += src && typeof src.length === 'number' ? src.length : 0;
    return origSet.call(this, src, offset);
  };
  try {
    for (let i = 0; i < count; i++) fs.writeSync(fd, chunk);
  } finally {
    Uint8Array.prototype.set = origSet;
  }
  fs.closeSync(fd);

  return { copied, fs };
}

const { copied, fs } = writeLoop('/home/user/out.bin', WRITES);

// Correctness first: the file is exactly what was written.
const written = fs.readFileSync('/home/user/out.bin');
assert.equal(written.byteLength, TOTAL, 'the file holds every written byte');
assert.ok(written.every((b) => b === 0x41), 'no gap or stale byte in the written range');

// A linear append moves each byte once, plus the copies made when the
// reservation is outgrown — geometric growth caps those at ~2x the total.
// The pre-fix rebuild moved ~WRITES/2 times the total (256x here).
assert.ok(
  copied <= TOTAL * 8,
  `appending ${TOTAL} bytes in ${WRITES} chunks moved ${copied} bytes ` +
    `(${(copied / TOTAL).toFixed(1)}x the data) — the write loop is quadratic`,
);

// Doubling the loop must roughly double the work, not quadruple it. This is
// the shape of the bug, independent of any constant.
const half = writeLoop('/home/user/half.bin', WRITES / 2).copied;

assert.ok(
  copied < half * 3,
  `doubling the write count multiplied the copied bytes by ${(copied / half).toFixed(1)} — expected ~2 (linear), got quadratic growth`,
);

console.log(
  `ok - node-shims-fd-write-growth (${WRITES} x ${CHUNK}B moved ${(copied / TOTAL).toFixed(1)}x the data)`,
);
