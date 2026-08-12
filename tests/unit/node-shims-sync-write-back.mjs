#!/usr/bin/env bun
// A synchronous write parks bytes in the facet and nothing else. Until the
// debounced write-back the ONLY thing that carried them to the authority was
// the drain at process exit — so a resident server that wrote synchronously
// never wrote back at all, and a peer reading the same path saw the pre-write
// bytes for the entire life of the process. Measured, not theorised.
//
// This drives the REAL shim against the REAL SqliteVFS and asserts three
// things the fix has to hold together:
//   1. writeFileSync / appendFileSync reach the authority while the process
//      is still running.
//   2. The batching survives: a burst of sync writes to one path costs one
//      round trip, not one per write.
//   3. The parked-write ledger is drained, so the exit drain has nothing left.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const enc = new TextEncoder();
const dec = new TextDecoder();
const dir = '/home/user/t';
vfs.mkdir(dir, { recursive: true });

// The append protocol is identity-bound: one live writer per pid.
const APPEND_PID = 7;
const writerId = crypto.randomUUID();
rawVfs.activateAppendWriter(APPEND_PID, writerId);
async function digestOf(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

let writeRpcs = 0;
let appendRpcs = 0;
const supervisor = {
  readFile: async (p) => { const b = await bridge.readFile(p); return b ? dec.decode(b) : null; },
  writeFile: (p, c) => { writeRpcs++; return bridge.writeFile(p, c); },
  stat: (p) => bridge.stat(p),
  lstat: (p) => bridge.stat(p, { followSymlinks: false }),
  readdir: (p) => bridge.readdir(p),
  exists: async (p) => (await bridge.stat(p)) !== null,
  access: (p, m) => bridge.access(p, m),
  mkdir: (p) => bridge.mkdir(p, { recursive: true }),
  fsReadRange: (p, o, l) => bridge.readRange(p, o, l),
  fsAppend: async (p, moduleId, opId, bytes) => {
    appendRpcs++;
    return bridge.appendOnce(p, APPEND_PID, writerId, moduleId, Number(opId), await digestOf(bytes), bytes);
  },
  fsAppendAck: (moduleId, opId) =>
    bridge.acknowledgeAppend(APPEND_PID, writerId, moduleId, Number(opId)),
  fsAcquire: (epoch, cursor) => bridge.acquire(epoch, cursor),
};

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() +
    '\n;return { fs: __fsMod, parked: () => Object.keys(__vfsWrites) };',
);
const out = factory(
  {},
  { 'home/user/t': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } },
  {},
  { 'home/user': ['t'], 'home/user/t': [] },
  supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  dir, [], {}, `${dir}/s.mjs`, dir,
);
const { fs, parked } = out;

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const authority = async (p) => {
  const bytes = await bridge.readFile(p);
  return bytes === null ? null : dec.decode(bytes);
};

// Warm the coherence cursor first. A facet's very first ACQUIRE reports a
// poison — it holds no epoch yet — which evicts the whole resident set and
// refetches it, and a refetch of a path that has a parked write flushes that
// write on the way past. Incidental, and not the write-back under test, so
// spend it before measuring anything.
await fs.promises.readFile(`${dir}/.warm`, 'utf8').catch(() => {});

// ── 1. a plain sync write reaches the authority while the process runs ──
fs.writeFileSync(`${dir}/w.txt`, 'SYNC_WRITTEN');
assert.equal(await authority(`${dir}/w.txt`), null, 'not written through synchronously');
await settle(60);
assert.equal(
  await authority(`${dir}/w.txt`),
  'SYNC_WRITTEN',
  'writeFileSync reached the authority without waiting for process exit',
);
assert.deepEqual(parked(), [], 'the ledger drained the parked cell');

// ── 2. appendFileSync too ──
fs.appendFileSync(`${dir}/a.txt`, 'A1');
fs.appendFileSync(`${dir}/a.txt`, 'A2');
await settle(60);
assert.equal(
  await authority(`${dir}/a.txt`),
  'A1A2',
  'appendFileSync reached the authority without waiting for process exit',
);

// ── 3. the batching survives: a burst is one round trip, not N ──
const before = writeRpcs;
for (let i = 0; i < 500; i++) fs.writeFileSync(`${dir}/burst.txt`, `v${i}`);
await settle(80);
assert.equal(await authority(`${dir}/burst.txt`), 'v499', 'the last value won');
const spent = writeRpcs - before;
assert.ok(
  spent > 0 && spent <= 3,
  `500 sync writes to one path cost ${spent} write RPCs — the batch must not become one RPC per write`,
);
assert.deepEqual(parked(), [], 'nothing left parked after the burst');

console.log(`node-shims-sync-write-back: all assertions passed (burst cost ${spent} write RPC(s))`);
