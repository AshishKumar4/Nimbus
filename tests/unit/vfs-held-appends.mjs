#!/usr/bin/env bun
// Appends through a descriptor are held by the VFS and stored a block at a
// time, and nothing can tell.
//
// Each write to the store rewrites the file's growing last chunk and, in a
// Durable Object, costs a commit, so `yes | head -c 48M > f` (8 KiB writes)
// took 43 s on a local workerd. The shell used to hold a redirection's
// writes itself (shell/file-sink.ts), which other writers and its own error
// handling could see. What has to hold, now that SqliteVFS holds them:
//
//   (1) a write that cannot be stored fails the command that made it, with
//       its own status, its message on its own stderr: at the write (the
//       storage limit, /dev/full) and when the command ends (a held append
//       the store refuses then);
//   (2) appends through two descriptions and a path write land in the order
//       they were made: `node -e "write A; appendFileSync B; write C" >> log`
//       is ABC;
//   (3) an aborted command keeps what it wrote and its signal's status (130);
//   (4) every look at the file sees a held append: path stat, read and
//       range, another description, readdir sizes, the revision and the
//       change feed, a snapshot, a rename, a truncate, an overwrite;
//   (5) a held append's failure goes to the descriptions that wrote it (the
//       next write, fsync or close), never to a reader or another writer;
//   (6) 1-byte appends in a loop are stored a run at a time, not one by one.

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const text = (bytes) => new TextDecoder().decode(bytes);
const bytesOf = (value) => new TextEncoder().encode(value);
/** Bytes that never repeat, so no chunk is stored once for many. */
const noise = (length, seed) => {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
};

/** A workspace over its own database; `limit` caps its storage (N18). */
async function workspace(limit) {
  const harness = createSqliteVfsTestHarness();
  let blobBytes = 0;
  const sql = {
    exec(query, ...params) {
      for (const param of params) if (param instanceof Uint8Array) blobBytes += param.byteLength;
      return harness.sql.exec(query, ...params);
    },
  };
  const vfs = limit === undefined ? undefined : new SqliteVFS(sql, harness.ctx, undefined, { storageLimit: limit(harness), storageKernelReserve: 0 });
  const ws = await NimbusWorkspace.create({ sql, transactions: harness.ctx, generation: 1, ...(vfs ? { vfs } : {}) });
  return { ws, vfs: ws.vfs, handed: () => blobBytes };
}

const exec = (ws, line, options = {}) => ws.exec(line, { cwd: '/home/user', ...options });

// ── (1) a write the store refuses fails its command, not the shell ────────
{
  const { ws, vfs } = await workspace((harness) => {
    const probe = new SqliteVFS(harness.sql, harness.ctx);
    return probe.databaseBytes() + 8 * 1048576;
  });
  // At the write: past the storage limit, and /dev/full.
  let r = await exec(ws, 'seq 1 3000000 > big 2> err; echo rc=$?; cat err');
  assert.match(r.stdout, /^rc=1\n.*ENOSPC/s, `(1) a write past the storage limit fails its command (${JSON.stringify(r.stdout.slice(0, 200))}, ${r.stderr})`);
  assert.equal(r.exitCode, 0, '(1) and the shell goes on');
  await exec(ws, 'rm -f big err');
  r = await exec(ws, 'echo x > /dev/full 2>/dev/null; echo rc=$?');
  assert.deepEqual([r.stdout, r.stderr], ['rc=1\n', ''], '(1) /dev/full: ENOSPC is the command\'s, on its stderr redirect');

  // When the command ends: what it appended is held, and the store refuses
  // it then (a facet took the room meanwhile: N18 fills do not pass the VFS).
  ws.registry.register('take-room-after-writing', async (ctx) => {
    await ctx.stdout.writeBytes(noise(64 * 1024, 7));
    const view = vfs.ledger.view();
    vfs.ledger.fill('room-taker', view.limit - vfs.ledger.kernelReserve - view.used);
    return 0;
  });
  r = await exec(ws, 'take-room-after-writing > held.bin 2>/dev/null; echo rc=$?');
  assert.deepEqual([r.stdout, r.stderr, r.exitCode], ['rc=1\n', '', 0],
    '(1) a held append the store refuses at the command\'s end fails that command, its message on its stderr redirect');
  vfs.ledger.deleteFacet('room-taker');
  r = await exec(ws, 'take-room-after-writing > held.bin; echo rc=$?');
  assert.equal(r.stdout, 'rc=1\n');
  assert.match(r.stderr, /^take-room-after-writing: .*ENOSPC/, `(1) without a redirect the message is on the command's stderr (${r.stderr})`);
  vfs.ledger.deleteFacet('room-taker');
  assert.equal((await exec(ws, 'wc -c < held.bin')).stdout.trim(), '0', '(1) what was refused is not in the file');
  await ws.close();
}

const { ws, vfs, handed } = await workspace();

// ── (2) appends land in the order they were made ───────────────────────────
{
  let r = await exec(ws, `node -e "process.stdout.write('A'); require('fs').appendFileSync('log','B'); process.stdout.write('C')" >> log; cat log`);
  assert.equal(r.stdout, 'ABC', `(2) node's stdout and its appendFileSync interleave as made (${r.stderr})`);
  r = await exec(ws, 'printf A >> two; { printf B; printf C >> two; printf D; } >> two; cat two');
  assert.equal(r.stdout, 'ABCD', '(2) two descriptions appending to one file');
}

// ── (3) an aborted command keeps its writes and its status ────────────────
{
  let wrote;
  const written = new Promise((resolve) => { wrote = resolve; });
  ws.registry.register('write-then-wait', async (ctx) => {
    await ctx.stdout.writeBytes(noise(5000, 3));
    wrote();
    await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
    return 0;
  });
  const controller = new AbortController();
  const pending = exec(ws, 'write-then-wait > partial.bin', { signal: controller.signal });
  await written;
  controller.abort();
  const r = await pending;
  assert.equal(r.exitCode, 130, `(3) an aborted command's status is its signal's (${r.stderr})`);
  assert.equal((await ws.fs.stat('/home/user/partial.bin')).size, 5000, '(3) what it wrote before the abort is in the file');
  assert.deepEqual(await ws.fs.readFile('/home/user/partial.bin'), noise(5000, 3));
}

// ── (4) every look at the file sees a held append ─────────────────────────
{
  const root = vfs.as(CRED_KERNEL);
  const path = 'home/user/seen.txt';
  root.writeFile(path, bytesOf('base:'));
  const writer = vfs.openDescription(path, CRED_KERNEL, { read: false, write: true });
  const reader = vfs.openDescription(path, CRED_KERNEL, { read: true, write: false });
  /** Append `piece` at the end through the writer: held, as a redirection's write is. */
  const append = (piece) => writer.write(writer.end(), bytesOf(piece));

  append('one');
  assert.equal(root.stat(path).size, 8, '(4) stat by path');
  append('two');
  assert.equal(text(root.readFile(path)), 'base:onetwo', '(4) read by path');
  append('3');
  assert.equal(text(root.readRange(path, 8, 4)), 'two3', '(4) a range read');
  append('4');
  assert.equal(reader.stat().size, 13, '(4) another description\'s fstat');
  append('5');
  assert.equal(text(reader.read(0, 100)), 'base:onetwo345', '(4) another description\'s read');
  append('6');
  assert.equal(root.list(null, 1000).entries.find((entry) => entry.path === `/${path}` || entry.path === path)?.size, 15, '(4) a listing\'s size');
  const revision = vfs.revision(path);
  const feed = vfs.invalidatedSince(vfs.epoch, vfs.revision());
  append('7');
  assert.ok(vfs.revision(path) > revision, '(4) the path\'s revision moves');
  assert.ok(vfs.invalidatedSince(feed.epoch, feed.rev).paths.some((entry) => entry.path === path), '(4) the change feed names it');
  append('8');
  vfs.snapshot('held');
  assert.equal(text(vfs.at('held').readFile(path)), 'base:onetwo345678', '(4) a snapshot holds it');
  vfs.dropSnapshot('held');
  append('9');
  root.rename(path, 'home/user/moved.txt');
  assert.equal(text(root.readFile('home/user/moved.txt')), 'base:onetwo3456789', '(4) a rename takes it along');
  append('X');
  writer.write(5, bytesOf('ONE'));
  assert.equal(text(reader.read(0, 100)), 'base:ONEtwo3456789X', '(4) an overwrite lands on it');
  append('Y');
  root.truncate('home/user/moved.txt', 6);
  append('!');
  assert.equal(text(root.readFile('home/user/moved.txt')), 'base:O!', '(4) a truncate cuts it, and the next append follows');
  writer.close();
  reader.close();
}

// ── (5) a held append's failure goes to its writers, not a reader ──────────
{
  const root = vfs.as(CRED_KERNEL);
  const path = 'home/user/lost.bin';
  root.writeFile(path, new Uint8Array(0));
  const writer = vfs.openDescription(path, CRED_KERNEL, { read: false, write: true });
  const other = vfs.openDescription(path, CRED_KERNEL, { read: true, write: true });
  const idle = vfs.openDescription(path, CRED_KERNEL, { read: false, write: true });
  const reader = vfs.openDescription(path, CRED_KERNEL, { read: true, write: false });
  const takeRoom = () => {
    const view = vfs.ledger.view();
    vfs.ledger.fill('room-taker', view.limit - vfs.ledger.kernelReserve - view.used);
  };
  writer.write(0, noise(4096, 11));
  other.write(other.end(), noise(512, 12));
  takeRoom();
  assert.equal(reader.stat().size, 0, '(5) a reader sees the file the store kept, and is told nothing');
  assert.throws(() => writer.write(writer.end(), bytesOf('x')), { code: 'ENOSPC' }, '(5) a writer\'s next write reports it');
  assert.throws(() => other.flush(), { code: 'ENOSPC' }, '(5) so does the other writer\'s fsync');
  assert.doesNotThrow(() => other.flush(), '(5) once');
  assert.doesNotThrow(() => idle.flush(), '(5) a description that wrote none of it is told nothing');
  vfs.ledger.deleteFacet('room-taker');
  writer.write(0, bytesOf('kept'));
  assert.doesNotThrow(() => writer.close(), '(5) a later append is stored at close');
  assert.equal(text(root.readFile(path)), 'kept');
  idle.write(4, bytesOf('!'));
  takeRoom();
  assert.throws(() => idle.close(), { code: 'ENOSPC' }, '(5) close reports what storing its appends failed with');
  vfs.ledger.deleteFacet('room-taker');
  assert.doesNotThrow(() => other.close());
  reader.close();
  assert.equal(text(root.readFile(path)), 'kept');
}

// ── (6) 1-byte appends in a loop are stored a run at a time ──────────────────
{
  const before = handed();
  const started = performance.now();
  const r = await exec(ws, 'for i in $(seq 1 3000); do printf x; done > ones.txt; wc -c < ones.txt');
  const elapsed = performance.now() - started;
  assert.equal(r.stdout.trim(), '3000');
  const amplification = (handed() - before) / 3000;
  console.log(`  3000 1-byte appends: ${elapsed.toFixed(0)} ms, the database was handed ${amplification.toFixed(2)}x`);
  // Stored once per run written (a block, 100 ms, the loop's end), not once
  // per append: each rewrote the whole growing file, 1564x on the shell's sink.
  assert.ok(amplification < 20, `(6) 1-byte appends are stored a run at a time, not one by one (${amplification.toFixed(2)}x)`);
}

await ws.close();
console.log('ok - vfs-held-appends (a failed write is its command\'s, appends land in order, an abort keeps them, nothing can tell they were held)');
