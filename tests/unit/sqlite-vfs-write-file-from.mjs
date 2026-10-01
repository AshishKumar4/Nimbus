#!/usr/bin/env bun
// writeFileFrom: writeFile of a file whose bytes arrive over time.
//
// The streamed file is the same file writeFile would have made — same bytes,
// same content key, same mode and owner — published whole by one transaction
// after bounded staging ones, and nothing at all when the source ends short,
// runs long or throws, with no staged content left behind.
//
// Its reason to exist is the cost of the alternative. Appending the same
// bytes with writeRange re-cuts the file's tail at every append, and an
// append past half a transaction's blob bound copies the manifest of the
// whole prefix into a new content: `nimbus install clang` wrote 50.6 MiB that
// way and its session spent ~77,000 row writes on it (5,843 streamed).

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { supervisorFilesystem } from '../../packages/core/src/runtime/vfs-supervisor.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const KERNEL = { uid: 0, gid: 0, groups: [0], umask: 0o022 };
const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const MiB = 1024 * 1024;

const open = () => {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  vfs.as(KERNEL).mkdir('home/user', { recursive: true });
  vfs.as(KERNEL).chown('home/user', 1000, 1000);
  return { harness, vfs, fs: vfs.as(USER) };
};

const bytesOf = (size, seed = 1) => {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out[i] = x >>> 24; }
  return out;
};

async function* pieces(bytes, size = 512 * 1024) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.slice(at, at + size);
}

const rows = (harness, sql) => Number(harness.db.query(sql).get().n);

// ── The file writeFile would have made, in bounded transactions ─────────────
{
  const { harness, fs } = open();
  const data = bytesOf(9 * MiB + 12_345);
  const before = harness.transactionCount;
  const revision = await fs.writeFileFrom('home/user/big.bin', data.length, pieces(data, 300_007));
  const transactions = harness.transactionCount - before;
  assert.deepEqual(fs.readFile('home/user/big.bin'), data);
  assert.equal(revision, fs.revision(), 'answers the revision its publication produced');
  fs.writeFile('home/user/copy.bin', data);
  assert.equal(fs.contentKey('home/user/big.bin'), fs.contentKey('home/user/copy.bin'), 'cut exactly as writeFile cuts');
  const stat = fs.stat('home/user/big.bin');
  assert.equal(stat.mode & 0o777, 0o644);
  assert.equal(stat.uid, 1000);
  assert.ok(transactions <= 2 * 10, `${transactions} transactions for ${(data.length / MiB).toFixed(1)} MiB`);
  console.log(`  ok  a ${(data.length / MiB).toFixed(1)} MiB file streams in ${transactions} transactions, identical to writeFile's`);
}

// ── An existing file keeps its mode and owner; a small file is one chunk ───
{
  const { fs, vfs } = open();
  fs.writeFile('home/user/kept', 'old');
  fs.chmod('home/user/kept', 0o600);
  const small = bytesOf(40_000);
  await fs.writeFileFrom('home/user/kept', small.length, pieces(small, 7_000), { mode: 0o666 });
  assert.deepEqual(fs.readFile('home/user/kept'), small);
  assert.equal(fs.stat('home/user/kept').mode & 0o777, 0o600, 'rewriting never changes the mode');
  await vfs.as(KERNEL).writeFileFrom('home/user/root-made', 3, pieces(new Uint8Array([1, 2, 3])));
  assert.equal(fs.stat('home/user/root-made').uid, 0, 'a new file belongs to its writer');
  console.log('  ok  mode and ownership follow writeFile');
}

// ── A source that is not the declared size, or fails, publishes nothing ────
for (const [label, size, source, expected] of [
  ['ends short', 3 * MiB + 1, (data) => pieces(data), /ended after 3145728 of the 3145729 bytes/],
  ['runs long', 3 * MiB - 1, (data) => pieces(data), /ran past the 3145727 bytes/],
  ['throws', 3 * MiB, async function* (data) { yield data.slice(0, MiB); throw new Error('connection reset'); }, /connection reset/],
]) {
  const { harness, fs, vfs } = open();
  const prior = bytesOf(100_000, 7);
  fs.writeFile('home/user/f', prior);
  await assert.rejects(() => fs.writeFileFrom('home/user/f', size, source(bytesOf(3 * MiB))), expected);
  assert.deepEqual(fs.readFile('home/user/f'), prior, `${label}: the file changed`);
  while (vfs.runContentMaintenance(64).transactions > 0) { /* drain the GC queue */ }
  const live = rows(harness, "SELECT COUNT(*) AS n FROM vfs_content_chunks WHERE content_id IN (SELECT content_id FROM vfs_inodes WHERE content_id IS NOT NULL)");
  const stored = rows(harness, 'SELECT COUNT(*) AS n FROM vfs_content_chunks');
  assert.equal(stored, live, `${label}: ${stored - live} staged manifest rows outlive the refusal`);
  console.log(`  ok  a source that ${label} publishes nothing and leaves no staged content`);
}

// ── Refused before a byte is read, as writeFile is refused ──────────────────
{
  const { fs } = open();
  let pulled = 0;
  const counted = async function* () { pulled++; yield new Uint8Array(1); };
  await assert.rejects(() => fs.writeFileFrom('etc-not-mine', 1, counted()), /EACCES/);
  await assert.rejects(() => fs.writeFileFrom('home/user', 1, counted()), /EISDIR/);
  assert.equal(pulled, 0);
  console.log('  ok  a write writeFile would refuse reads nothing');
}

// ── Over RPC an iterable cannot go: a program's filesystem refuses it ───────
{
  const remote = supervisorFilesystem({});
  let pulled = 0;
  const counted = async function* () { pulled++; yield new Uint8Array(1); };
  await assert.rejects(() => remote.writeFileFrom('/home/user/remote.bin', 1, counted()), /ENOTSUP/);
  assert.equal(pulled, 0);
  console.log('  ok  a program reaching its host over RPC is refused (it writes a W7 stream instead)');
}

console.log('sqlite-vfs-write-file-from: ok');
