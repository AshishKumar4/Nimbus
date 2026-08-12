#!/usr/bin/env bun
// Behavior tests for fs.createReadStream / fs.ReadStream inside a node facet.
//
// A static file server is the canonical consumer:
//     fs.createReadStream(file).pipe(res)
//     fs.createReadStream(file).on('data', ...)
// Both idioms MUST deliver the file's bytes. They must also work for a file
// that is NOT resident in the facet's prefetch bundle (the VFS is the source
// of truth; the bundle is only a cache), for files larger than any single RPC
// payload, and for the `start`/`end` range options that HTTP Range serving
// and partial reads depend on.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);

/** Largest single range read the shim is allowed to request from the supervisor. */
let maxRangeLength = 0;
let rangeCalls = 0;

const supervisor = {
  readFile: async (p) => { const b = await bridge.readFile(p); return b ? new TextDecoder().decode(b) : null; },
  readFileBytes: (p) => bridge.readFile(p),
  stat: (p) => bridge.stat(p),
  lstat: (p) => bridge.stat(p, { followSymlinks: false }),
  exists: async (p) => (await bridge.stat(p)) !== null,
  readdir: (p) => bridge.readdir(p),
  fsReadRange: (p, o, l) => {
    rangeCalls++;
    if (l > maxRangeLength) maxRangeLength = l;
    return bridge.readRange(p, o, l);
  },
  fsWriteRange: (p, o, b) => bridge.writeRange(p, o, b),
  fsTruncate: (p, s) => bridge.truncate(p, s),
  writeFile: (p, c) => bridge.writeFile(p, c),
};

const code = generateShimsCode();
const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + code + '\n;return { fs: __fsMod, stream: __streamMod };',
);
const sandbox = factory(
  {}, {}, {}, {}, null, supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
);
const fs = sandbox.fs;

// ── fixtures: live-only files, never placed in __vfsBundle ───────────────
vfs.mkdir('home/user', { recursive: true });
const SMALL = new TextEncoder().encode('hello-from-the-vfs');
vfs.writeFile('home/user/small.txt', SMALL);

// 5 MiB + a tail, so the stream must issue many bounded reads and the final
// partial chunk is exercised.
const BIG_LEN = 5 * 1024 * 1024 + 1234;
const BIG = new Uint8Array(BIG_LEN);
for (let i = 0; i < BIG_LEN; i++) BIG[i] = (i * 7 + 13) & 0xff;
vfs.writeFile('home/user/big.bin', BIG);

const collect = (stream) => new Promise((resolve, reject) => {
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  stream.on('end', () => resolve(concat(chunks)));
  stream.on('error', reject);
});

const drain = (stream) => new Promise((resolve, reject) => {
  const chunks = [];
  const sink = new sandbox.stream.Writable({
    write(chunk, encoding, cb) { chunks.push(chunk); cb(); },
  });
  sink.on('finish', () => resolve(concat(chunks)));
  sink.on('error', reject);
  stream.on('error', reject);
  stream.pipe(sink);
});

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`stalled: ${label}`)), ms)),
]);

function assertBytesEqual(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) assert.fail(`${label}: byte ${i} ${actual[i]} !== ${expected[i]}`);
  }
}

// 1. `.on('data')` — attaching a data listener must start the flow (Node's
//    flowing-mode contract). Pre-fix this hung forever.
assertBytesEqual(
  await withTimeout(collect(fs.createReadStream('/home/user/small.txt')), 5000, "on('data') small"),
  SMALL, "on('data') small",
);

// 2. `.pipe(dest)` — the express.static / send idiom.
assertBytesEqual(
  await withTimeout(drain(fs.createReadStream('/home/user/small.txt')), 5000, 'pipe small'),
  SMALL, 'pipe small',
);

// 3. `for await` — the async-iterator idiom must keep working.
{
  const chunks = [];
  for await (const c of fs.createReadStream('/home/user/small.txt')) chunks.push(c);
  assertBytesEqual(concat(chunks), SMALL, 'async-iterate small');
}

// 4. A multi-MB live-only file streams byte-exact through both idioms, and
//    never asks the supervisor for more than one bounded chunk at a time.
maxRangeLength = 0; rangeCalls = 0;
assertBytesEqual(
  await withTimeout(collect(fs.createReadStream('/home/user/big.bin')), 30000, "on('data') big"),
  BIG, "on('data') big",
);
assert.ok(rangeCalls > 1, 'big file must be read in multiple bounded ranges');
assert.ok(
  maxRangeLength <= 1024 * 1024,
  `bounded-buffer invariant: single range read was ${maxRangeLength} bytes`,
);

assertBytesEqual(
  await withTimeout(drain(fs.createReadStream('/home/user/big.bin')), 30000, 'pipe big'),
  BIG, 'pipe big',
);

// 5. `start`/`end` ranges (HTTP Range serving). `end` is INCLUSIVE in Node.
{
  const got = await withTimeout(
    collect(fs.createReadStream('/home/user/big.bin', { start: 1_000_000, end: 1_099_999 })),
    30000, 'ranged read',
  );
  assertBytesEqual(got, BIG.subarray(1_000_000, 1_100_000), 'ranged read');
}
{
  const got = await withTimeout(
    collect(fs.createReadStream('/home/user/small.txt', { start: 6 })),
    5000, 'open-ended range',
  );
  assertBytesEqual(got, SMALL.subarray(6), 'open-ended range');
}

// 6. An encoding option yields strings, as in Node.
{
  const chunks = [];
  for await (const c of fs.createReadStream('/home/user/small.txt', 'utf8')) chunks.push(c);
  assert.equal(chunks.join(''), 'hello-from-the-vfs');
}

// 7. A missing file emits 'error' — it must not hang and must not throw
//    synchronously out of createReadStream.
await assert.rejects(
  withTimeout(collect(fs.createReadStream('/home/user/nope.bin')), 5000, 'missing file'),
  /ENOENT/,
);

// 8. fs.ReadStream (the exported class graceful-fs re-parents) behaves the same.
assertBytesEqual(
  await withTimeout(collect(new fs.ReadStream('/home/user/small.txt')), 5000, 'ReadStream class'),
  SMALL, 'ReadStream class',
);

console.log('node-shims-read-stream: OK');
