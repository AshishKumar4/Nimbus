#!/usr/bin/env bun
// A whole-file flush stamps the facet's resident cell with the revision it
// produced, so the ACQUIRE barrier can tell that write apart from a peer's.
// Every OTHER mutation this facet makes to a path it holds — a ranged
// FileHandle write, truncate, utimes, chmod, chown — bumps the authority's
// per-path revision exactly the same way, and without a stamp the next
// barrier reads the facet's own mutation as a peer's, evicts the cell, and a
// readFileSync that follows fails EAGAIN on bytes the facet just wrote.
// Live, that is modern-tar's open → write → futimes → close followed by a
// sync read of the extracted README, which exits create-astro with 1.
//
// The repair: every such RPC answers with the path's revision before and
// after, and the facet advances the stamp only when the cell was current at
// `before`. This test pins both directions against the real SqliteVFS: each
// of the five own mutations survives the barrier, and a peer write landing
// between the facet's write and its mutation still evicts.

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
const dir = '/home/user/p';
vfs.mkdir(dir, { recursive: true });

const WRITER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
rawVfs.activateAppendWriter(1, WRITER);
const supervisor = {
  readFile: async (p) => { const b = await bridge.readFile(p); return b ? dec.decode(b) : null; },
  writeFile: (p, c) => bridge.writeFile(p, c),
  stat: (p) => bridge.stat(p),
  lstat: (p) => bridge.stat(p, { followSymlinks: false }),
  readdir: (p) => bridge.readdir(p),
  exists: async (p) => (await bridge.stat(p)) !== null,
  access: (p, m) => bridge.access(p, m),
  mkdir: (p) => bridge.mkdir(p, { recursive: true }),
  fsReadRange: (p, o, l) => bridge.readRange(p, o, l),
  fsWriteRange: (p, o, b) => bridge.writeRange(p, o, b),
  fsTruncate: (p, s) => bridge.truncate(p, s),
  async fsAppend(p, moduleId, operationId, bytes) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return bridge.appendOnce(p, 1, WRITER, moduleId, Number(operationId), digest, bytes);
  },
  fsAppendAck: (moduleId, operationId) => bridge.acknowledgeAppend(1, WRITER, moduleId, Number(operationId)),
  utimes: (p, a, m) => bridge.utimes(p, a, m),
  chmod: (p, m) => bridge.chmod(p, m),
  chown: (p, u, g, o) => bridge.chown(p, u, g, o),
  fsAcquire: (epoch, cursor) => bridge.acquire(epoch, cursor),
};

globalThis.__nimbusVfsCursor = { epoch: rawVfs.epoch, rev: rawVfs.revision() };

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode()
  + '\n;return { fs: __fsMod, setTimeout: globalThis.setTimeout };',
);
const out = factory(
  {},
  { 'home/user/p': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } },
  {}, { 'home/user': ['p'], 'home/user/p': [] }, supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, dir, [], {}, `${dir}/s.mjs`, dir,
);
const { fs } = out;
const stats = globalThis.__nimbusVfsCoherence;

// An async stat is the cheapest ACQUIRE: it evicts what the authority
// reports as changed and refetches nothing, which is exactly the shape in
// which an own mutation used to turn into an EAGAIN.
const barrier = () => fs.promises.stat(dir);
// A shim timer is a barrier that also refetches what it dropped: the shape
// that makes a peer's bytes visible to the next sync read.
const timerBarrier = (fn) => new Promise((resolve, reject) => {
  out.setTimeout(() => { try { resolve(fn()); } catch (error) { reject(error); } }, 5);
});
const syncRead = (p) => {
  try { return fs.readFileSync(p, 'utf8'); } catch (error) { return `${error.code}: ${error.message}`; }
};
const snap = () => ({ invalidations: stats.invalidations, selfWrites: stats.selfWrites, fills: stats.fills });
let n = 0;
const fresh = (label) => `${dir}/${label}-${n++}.txt`;

// Asserts that the barrier after an own mutation of `p` kept the cell: the
// sync read serves `expected`, nothing was refetched, and the barrier
// counted the path as this facet's own rather than dropping it.
async function survives(label, p, expected, before) {
  await barrier();
  assert.equal(syncRead(p), expected, `${label}: sync read after the barrier serves the mutated bytes`);
  assert.equal(stats.fills, before.fills, `${label}: nothing was refetched`);
  assert.ok(stats.selfWrites > before.selfWrites, `${label}: the barrier recognised the mutation as this facet own`);
  assert.equal(await supervisor.readFile(p), expected, `${label}: the authority holds the same bytes`);
}

// Reference: how many invalidations a barrier costs when only the
// directory record is stale (the parent is deliberately never stamped).
const parentOnly = await (async () => {
  const p = fresh('ref');
  await fs.promises.writeFile(p, 'REF');
  const before = snap();
  await barrier();
  assert.equal(stats.fills, before.fills);
  return stats.invalidations - before.invalidations;
})();
assert.ok(parentOnly <= 1, `a flushed write costs at most the parent record (was ${parentOnly})`);

async function noFileInvalidation(label, before) {
  assert.ok(
    stats.invalidations - before.invalidations <= parentOnly,
    `${label}: the file itself was not invalidated (${stats.invalidations - before.invalidations} > ${parentOnly})`,
  );
}

// ── 1. Ranged write through a FileHandle ────────────────────────────────
{
  // Parked sync write, then the handle's write flushes it whole and lands
  // the range on top.
  const p = fresh('range-sync');
  fs.writeFileSync(p, 'HELLO WORLD');
  const fh = await fs.promises.open(p, 'r+');
  await fh.write('JELLO', 0);
  await fh.close();
  assert.equal(syncRead(p), 'JELLO WORLD', 'range: local overlay is immediate');
  const before = snap();
  await survives('range after sync write', p, 'JELLO WORLD', before);
  await noFileInvalidation('range after sync write', before);
}
{
  // Async whole write already flushed, then the ranged write alone.
  const p = fresh('range-async');
  await fs.promises.writeFile(p, 'HELLO WORLD');
  const fh = await fs.promises.open(p, 'r+');
  await fh.write(enc.encode('!!'), 0, 2, 9);
  await fh.close();
  const before = snap();
  await survives('range after async write', p, 'HELLO WOR!!', before);
  await noFileInvalidation('range after async write', before);
}
{
  // modern-tar's exact sequence: open with create, write, futimes, close,
  // then a sync read after an unrelated async call.
  const p = fresh('tar');
  const fh = await fs.promises.open(p, 'w');
  await fh.write('README');
  await fh.utimes(new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  await fh.close();
  const before = snap();
  await survives('open+write+futimes+close', p, 'README', before);
  await noFileInvalidation('open+write+futimes+close', before);
  assert.equal(fs.statSync(p).mtime.getTime(), 1_700_000_000_000, 'the sync stat carries the futimes');
}

// ── 2. Truncate ─────────────────────────────────────────────────────────
{
  // Live file: the RPC trims the boundary chunk, the local cell is trimmed.
  const p = fresh('trunc-async');
  await fs.promises.writeFile(p, 'HELLO WORLD');
  await fs.promises.truncate(p, 5);
  assert.equal(syncRead(p), 'HELLO', 'truncate: local trim is immediate');
  const before = snap();
  await survives('truncate of a flushed file', p, 'HELLO', before);
  await noFileInvalidation('truncate of a flushed file', before);
}
{
  // FileHandle.truncate is the same path from a descriptor.
  const p = fresh('ftrunc');
  await fs.promises.writeFile(p, 'HELLO WORLD');
  const fh = await fs.promises.open(p, 'r+');
  await fh.truncate(3);
  await fh.close();
  const before = snap();
  await survives('ftruncate', p, 'HEL', before);
  await noFileInvalidation('ftruncate', before);
}
{
  // A pending sync append rides ahead of the truncate as a flush, and the
  // truncate then lands on the flushed file. The ledger drops the resident
  // cell when it persists an append as a range (the cell is refetched on the
  // next live read), so there is no stamp to advance here and none is
  // claimed: the truncate must simply reach the authority in order.
  const p = fresh('trunc-append');
  await fs.promises.writeFile(p, 'HELLO');
  fs.appendFileSync(p, ' WORLD');
  await fs.promises.truncate(p, 7);
  assert.equal(await supervisor.readFile(p), 'HELLO W', 'the truncate landed after the flushed append');
  assert.equal(await fs.promises.readFile(p, 'utf8'), 'HELLO W');
}

// ── 3. utimes ───────────────────────────────────────────────────────────
const T = 1_600_000_000_000;
{
  const p = fresh('utimes-async');
  await fs.promises.writeFile(p, 'TIMES');
  await fs.promises.utimes(p, new Date(T), new Date(T));
  const before = snap();
  await survives('utimes', p, 'TIMES', before);
  await noFileInvalidation('utimes', before);
  assert.equal(fs.statSync(p).mtime.getTime(), T, 'utimes: the sync stat carries the new mtime');
  assert.equal((await fs.promises.stat(p)).mtime.getTime(), T, 'utimes: the authority carries the new mtime');
}
{
  // Sync write then async utimes: the utimes flushes the parked write first.
  const p = fresh('utimes-sync');
  fs.writeFileSync(p, 'TIMES2');
  await fs.promises.utimes(p, new Date(T), new Date(T));
  const before = snap();
  await survives('utimes after a sync write', p, 'TIMES2', before);
  await noFileInvalidation('utimes after a sync write', before);
}

// ── 4. chmod ────────────────────────────────────────────────────────────
{
  const p = fresh('chmod-async');
  await fs.promises.writeFile(p, 'MODE');
  await fs.promises.chmod(p, 0o755);
  const before = snap();
  await survives('chmod', p, 'MODE', before);
  await noFileInvalidation('chmod', before);
  assert.equal(fs.statSync(p).mode & 0o777, 0o755, 'chmod: the sync stat carries the mode');
  assert.equal((await fs.promises.stat(p)).mode & 0o777, 0o755, 'chmod: the authority carries the mode');
}
{
  // chmodSync parks the mode and it rides the next flush of the path,
  // which is the chmod RPC in _flushLocalPathToSupervisor.
  const p = fresh('chmod-sync');
  await fs.promises.writeFile(p, 'MODE2');
  fs.chmodSync(p, 0o700);
  await fs.promises.utimes(p, new Date(T), new Date(T));
  const before = snap();
  await survives('chmodSync ride-along', p, 'MODE2', before);
  await noFileInvalidation('chmodSync ride-along', before);
  assert.equal((await fs.promises.stat(p)).mode & 0o777, 0o700, 'chmodSync reached the authority');
}

// ── 5. chown ────────────────────────────────────────────────────────────
{
  const p = fresh('chown-async');
  await fs.promises.writeFile(p, 'OWNER');
  await fs.promises.chown(p, 1000, 1000);
  const before = snap();
  await survives('chown', p, 'OWNER', before);
  await noFileInvalidation('chown', before);
  assert.equal((await fs.promises.stat(p)).uid, 1000, 'chown reached the authority');
}
{
  // chownSync queues the RPC behind the parked write.
  const p = fresh('chown-sync');
  fs.writeFileSync(p, 'OWNER2');
  fs.chownSync(p, 1000, 1000);
  await fs.promises.access(p);
  const before = snap();
  await survives('chownSync', p, 'OWNER2', before);
  await noFileInvalidation('chownSync', before);
  assert.equal((await fs.promises.stat(p)).gid, 1000, 'chownSync reached the authority');
}

// ── The other direction: a peer touched the path in between ────────────
// The receipt's `before` is past the stamp, so the stamp must stay and the
// barrier must evict. The refetch then serves the peer bytes, with the
// facet's own metadata mutation applied on top.
{
  const p = fresh('peer-utimes');
  await fs.promises.writeFile(p, 'MINE');
  vfs.writeFile(p, enc.encode('PEER'));
  await fs.promises.utimes(p, new Date(T), new Date(T));
  const before = snap();
  const seen = await timerBarrier(() => fs.readFileSync(p, 'utf8'));
  assert.equal(seen, 'PEER', 'utimes after a peer write: the barrier still evicts and the peer bytes win');
  assert.ok(stats.invalidations > before.invalidations, 'utimes after a peer write: the file was invalidated');
  assert.equal((await fs.promises.stat(p)).mtime.getTime(), T, 'and the facet own utimes is applied on top');
}
{
  const p = fresh('peer-range');
  await fs.promises.writeFile(p, 'MINE_MINE');
  vfs.writeFile(p, enc.encode('PEERPEERPEER'));
  const fh = await fs.promises.open(p, 'r+');
  await fh.write('X', 0);
  await fh.close();
  const before = snap();
  const seen = await timerBarrier(() => fs.readFileSync(p, 'utf8'));
  assert.equal(seen, 'XEERPEERPEER', 'ranged write after a peer write: the barrier evicts and the refetch shows both');
  assert.ok(stats.invalidations > before.invalidations, 'ranged write after a peer write: the file was invalidated');
}
{
  const p = fresh('peer-trunc');
  await fs.promises.writeFile(p, 'MINE_MINE');
  vfs.writeFile(p, enc.encode('PEERPEERPEER'));
  await fs.promises.truncate(p, 6);
  const before = snap();
  const seen = await timerBarrier(() => fs.readFileSync(p, 'utf8'));
  assert.equal(seen, 'PEERPE', 'truncate after a peer write: the barrier evicts and the refetch shows both');
  assert.ok(stats.invalidations > before.invalidations, 'truncate after a peer write: the file was invalidated');
}

// A peer write to another path moves the global clock without touching
// ours: the stamp advances all the same and the cell survives.
{
  const p = fresh('clock');
  const other = fresh('clock-other');
  await fs.promises.writeFile(p, 'MINE');
  vfs.writeFile(other, enc.encode('ELSEWHERE'));
  await fs.promises.utimes(p, new Date(T), new Date(T));
  const before = snap();
  await barrier();
  assert.equal(syncRead(p), 'MINE', 'a peer write elsewhere does not unstamp our cell');
  assert.equal(stats.fills, before.fills);
  assert.ok(stats.selfWrites > before.selfWrites);
}

assert.equal(stats.poisons, 0, 'a seeded cursor is never poisoned');
console.log('node-shims-own-mutation-stamps: all assertions passed');
