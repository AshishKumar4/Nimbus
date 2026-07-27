#!/usr/bin/env bun
// The facet counts every supervisor fs READ round trip it issues.
//
// Reads are the only fs RPC a program can issue thousands of in one lifetime
// — an async whole-file read costs one round trip per READ_STREAM_CHUNK_BYTES
// — so the count is what has to move when reads are batched, coalesced or
// pipelined. Without it, a change to how reads are issued can only be
// asserted, not measured.
//
// Asserts the counter against a RECORDING supervisor over a real SqliteVFS:
// the number the facet reports must equal the number of read calls that
// actually crossed, and metadata calls must not inflate it.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/worker/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const CHUNK = 65536; // READ_STREAM_CHUNK_BYTES

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const enc = new TextEncoder();
const dec = new TextDecoder();
const dir = '/home/user/counted';

vfs.mkdir(dir, { recursive: true });
// Small enough for one round trip, and large enough for several.
vfs.writeFile(`${dir}/small.txt`, enc.encode('x'.repeat(10)));
vfs.writeFile(`${dir}/big.bin`, new Uint8Array(3 * CHUNK).fill(7));

// Every read call that actually crosses to the supervisor.
const rawCalls = { readFile: 0, fsReadRange: 0, stat: 0, readdir: 0 };

const supervisor = {
  readFile: async (path) => {
    rawCalls.readFile++;
    const bytes = await bridge.readFile(path);
    return bytes ? dec.decode(bytes) : null;
  },
  fsReadRange: (path, offset, length) => {
    rawCalls.fsReadRange++;
    return bridge.readRange(path, offset, length);
  },
  stat: (path) => { rawCalls.stat++; return bridge.stat(path); },
  lstat: (path) => bridge.stat(path, { followSymlinks: false }),
  readdir: (path) => { rawCalls.readdir++; return bridge.readdir(path); },
  exists: async (path) => (await bridge.stat(path)) !== null,
  writeFile: (path, content) => bridge.writeFile(path, content),
  mkdir: (path) => bridge.mkdir(path, { recursive: true }),
};

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() +
    '\n;return { fs: __fsMod };',
);
const { fs } = factory(
  {}, {}, {}, {},
  supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  dir, [], {}, `${dir}/script.mjs`, dir,
);
const fsp = fs.promises;

const counter = () => globalThis.__nimbusFsRpcReads;
const crossed = () => rawCalls.readFile + rawCalls.fsReadRange;

assert.equal(typeof counter(), 'number',
  'the facet does not expose a supervisor fs read counter, so no change to how reads are issued can be measured');

// ── one small file ──────────────────────────────────────────────────────
{
  const before = counter();
  const text = await fsp.readFile(`${dir}/small.txt`, 'utf8');
  assert.equal(text, 'x'.repeat(10));
  assert.ok(counter() > before, 'a whole-file async read recorded no supervisor read');
  assert.equal(counter() - before, crossed(),
    'counter disagrees with the number of read calls that actually crossed');
}

// ── metadata must not inflate the read count ────────────────────────────
{
  const before = counter();
  await fsp.stat(`${dir}/small.txt`);
  await fsp.readdir(dir);
  assert.ok(rawCalls.stat > 0 && rawCalls.readdir > 0, 'metadata calls did not cross');
  assert.equal(counter(), before,
    'stat/readdir inflated the read counter — it must count reads only');
}

// ── chunking amplification is visible ───────────────────────────────────
// This is the number a batching/pipelining change has to move: one logical
// read of a 3-chunk file costs more than one round trip.
{
  const before = crossed();
  const beforeCount = counter();
  const bytes = await fsp.readFile(`${dir}/big.bin`);
  assert.equal(bytes.byteLength, 3 * CHUNK);
  const roundTrips = crossed() - before;
  assert.ok(roundTrips > 1,
    `a ${3 * CHUNK}-byte read should span multiple ${CHUNK}-byte round trips, saw ${roundTrips}`);
  assert.equal(counter() - beforeCount, roundTrips,
    'counter missed chunked round trips');
  console.log(`  one ${3 * CHUNK}-byte async read = ${roundTrips} supervisor round trips`);
}

console.log(`node-shims-fs-rpc-read-count OK: counted ${counter()} supervisor fs reads`);
