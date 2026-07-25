#!/usr/bin/env bun
// A descriptor write loop must cost O(total bytes), not O(total bytes²).
//
// Every fd-style write lands in the facet's local sync-view cell. Rebuilding
// that whole cell per call means write N of a loop copies everything written
// so far, so appending a file in chunks moves ~N²/2 chunks of memory: a
// 26 MiB write loop moved gigabytes and OOM'd the facet.
//
// The assertion is on data movement rather than wall time — it is the thing
// that actually blew up, and it is deterministic. Uint8Array.prototype.set is
// how every copy in that path is made, so counting the bytes it moves during
// the loop measures the cost directly.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest',
  '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + generateShimsCode() + '\n;return { fs: __fsMod, Buffer: __BufferMod };',
);

const CHUNK = 4096;
const WRITES = 512;
const TOTAL = CHUNK * WRITES;

function measureWriteLoop() {
  const writes = {};
  const dirs = { 'home/user': true };
  const { fs, Buffer } = factory(
    {}, {}, writes, dirs, {}, null,
    { uid: 0, gid: 0, groups: [0], umask: 0o022 },
    '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  );

  const fd = fs.openSync('/home/user/out.bin', 'w');
  const chunk = Buffer.alloc(CHUNK, 0x41);

  const origSet = Uint8Array.prototype.set;
  let copied = 0;
  Uint8Array.prototype.set = function (src, offset) {
    copied += src && typeof src.length === 'number' ? src.length : 0;
    return origSet.call(this, src, offset);
  };
  try {
    for (let i = 0; i < WRITES; i++) fs.writeSync(fd, chunk);
  } finally {
    Uint8Array.prototype.set = origSet;
  }
  fs.closeSync(fd);

  return { copied, cell: writes['home/user/out.bin'] };
}

const { copied, cell } = measureWriteLoop();

// Correctness first: the file is exactly what was written.
assert.equal(cell.byteLength, TOTAL, 'the cell holds every written byte');
assert.ok(cell.every((b) => b === 0x41), 'no gap or stale byte in the written range');

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
const half = (() => {
  const writes = {};
  const { fs, Buffer } = factory(
    {}, {}, writes, { 'home/user': true }, {}, null,
    { uid: 0, gid: 0, groups: [0], umask: 0o022 },
    '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  );
  const fd = fs.openSync('/home/user/out.bin', 'w');
  const chunk = Buffer.alloc(CHUNK, 0x41);
  const origSet = Uint8Array.prototype.set;
  let copied = 0;
  Uint8Array.prototype.set = function (src, offset) {
    copied += src && typeof src.length === 'number' ? src.length : 0;
    return origSet.call(this, src, offset);
  };
  try {
    for (let i = 0; i < WRITES / 2; i++) fs.writeSync(fd, chunk);
  } finally {
    Uint8Array.prototype.set = origSet;
  }
  fs.closeSync(fd);
  return copied;
})();

assert.ok(
  copied < half * 3,
  `doubling the write count multiplied the copied bytes by ${(copied / half).toFixed(1)} — expected ~2 (linear), got quadratic growth`,
);

// The cell's BACKING BUFFER is what structured clone puts on the wire when the
// facet flushes it, and that payload is capped (MAX_RPC_SAFE_PAYLOAD_BYTES,
// 28 MiB). Growth reserve therefore cannot be unbounded: a 26 MiB file in a
// doubled 32 MiB buffer silently lost its write on a deployed worker.
{
  const writes = {};
  const { fs, Buffer } = factory(
    {}, {}, writes, { 'home/user': true }, {}, null,
    { uid: 0, gid: 0, groups: [0], umask: 0o022 },
    '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  );
  const fd = fs.openSync('/home/user/big.bin', 'w');
  const chunk = Buffer.alloc(1024 * 1024, 0x42);
  for (let i = 0; i < 20; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);

  const cell = writes['home/user/big.bin'];
  assert.equal(cell.byteLength, 20 * 1024 * 1024, 'the 20 MiB cell holds every byte');
  const reserve = cell.buffer.byteLength - cell.byteOffset - cell.byteLength;
  assert.ok(
    reserve <= 4 * 1024 * 1024,
    `a ${(cell.byteLength / 1048576).toFixed(0)} MiB cell carries ${(reserve / 1048576).toFixed(1)} MiB of ` +
      'growth reserve — the write RPC serialises the whole backing buffer, so the reserve is payload',
  );
}

console.log(
  `ok - node-shims-fd-write-growth (${WRITES} x ${CHUNK}B moved ${(copied / TOTAL).toFixed(1)}x the data)`,
);
