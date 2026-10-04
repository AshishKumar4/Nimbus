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
//   (6) 1-byte appends in a loop are stored a run at a time, not one by one;
//   (7) fsync on any descriptor of the file stores what is held for it, a
//       read-only one's included;
//   (8) a held append keeps the time it was made: a stat that stores it
//       later does not move the file's mtime or ctime;
//   (9) O_SYNC (`sync`) holds nothing, on SQLite and on a mount that cannot
//       write in place, so each write is in the store when it returns;
//  (10) only the held append's own publication carries its time: a watcher
//       its event reaches writes, and holds, at its own time.

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
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

// One workspace over a database whose blob bytes are counted: what has been
// handed to the store, which no look at the file can see past (4).
const harness = createSqliteVfsTestHarness();
let blobBytes = 0;
const sql = {
  exec(query, ...params) {
    for (const param of params) if (param instanceof Uint8Array) blobBytes += param.byteLength;
    return harness.sql.exec(query, ...params);
  },
};
const handed = () => blobBytes;
const ws = await NimbusWorkspace.create({ sql, transactions: harness.ctx, generation: 1 });
const vfs = ws.vfs;
const exec = (line, options = {}) => ws.exec(line, { cwd: '/home/user', ...options });
/** Leave the session user no room, as a facet's fill would (N18 fills do not pass the VFS). */
const takeRoom = () => {
  const view = vfs.ledger.view();
  vfs.ledger.fill('room-taker', view.limit - vfs.ledger.kernelReserve - view.used);
};
const giveRoom = () => vfs.ledger.deleteFacet('room-taker');

// ── (1) a write the store refuses fails its command, not the shell ────────
{
  // At the write: no room for it, and /dev/full. The file exists, so opening
  // it needs none.
  await exec('touch full.txt');
  takeRoom();
  let r = await exec('printf abc >> full.txt 2> /dev/null; echo rc=$?');
  giveRoom();
  assert.deepEqual([r.stdout, r.stderr, r.exitCode], ['rc=1\n', '', 0], `(1) a write past the storage limit fails its command, and the shell goes on (${r.stderr})`);
  takeRoom();
  r = await exec('printf abc >> full.txt; echo rc=$?');
  giveRoom();
  assert.equal(r.stdout, 'rc=1\n');
  assert.match(r.stderr, /ENOSPC/, `(1) and without a redirect its message is printed (${r.stderr})`);
  r = await exec('echo x > /dev/full 2>/dev/null; echo rc=$?');
  assert.deepEqual([r.stdout, r.stderr], ['rc=1\n', ''], '(1) /dev/full: ENOSPC is the command\'s, on its stderr redirect');

  // When the command ends: what it appended is held, and the store refuses
  // it then.
  ws.registry.register('take-room-after-writing', async (ctx) => {
    await ctx.stdout.writeBytes(noise(64 * 1024, 7));
    takeRoom();
    return 0;
  });
  r = await exec('take-room-after-writing > held.bin 2>/dev/null; echo rc=$?');
  giveRoom();
  assert.deepEqual([r.stdout, r.stderr, r.exitCode], ['rc=1\n', '', 0],
    '(1) a held append the store refuses at the command\'s end fails that command, its message on its stderr redirect');
  r = await exec('take-room-after-writing > held.bin; echo rc=$?');
  giveRoom();
  assert.equal(r.stdout, 'rc=1\n');
  assert.match(r.stderr, /^take-room-after-writing: .*ENOSPC/, `(1) without a redirect the message is on the command's stderr (${r.stderr})`);
  assert.equal((await exec('wc -c < held.bin')).stdout.trim(), '0', '(1) what was refused is not in the file');
}

// ── (2) appends land in the order they were made ───────────────────────────
{
  let r = await exec(`node -e "process.stdout.write('A'); require('fs').appendFileSync('log','B'); process.stdout.write('C')" >> log; cat log`);
  assert.equal(r.stdout, 'ABC', `(2) node's stdout and its appendFileSync interleave as made (${r.stderr})`);
  r = await exec('printf A >> two; { printf B; printf C >> two; printf D; } >> two; cat two');
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
  const pending = exec('write-then-wait > partial.bin', { signal: controller.signal });
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
  writer.write(0, noise(4096, 11));
  other.write(other.end(), noise(512, 12));
  takeRoom();
  assert.equal(reader.stat().size, 0, '(5) a reader sees the file the store kept, and is told nothing');
  assert.throws(() => writer.write(writer.end(), bytesOf('x')), { code: 'ENOSPC' }, '(5) a writer\'s next write reports it');
  assert.throws(() => other.flush(), { code: 'ENOSPC' }, '(5) so does the other writer\'s fsync');
  assert.doesNotThrow(() => other.flush(), '(5) once');
  assert.doesNotThrow(() => idle.flush(), '(5) a description that wrote none of it is told nothing');
  giveRoom();
  writer.write(0, bytesOf('kept'));
  assert.doesNotThrow(() => writer.close(), '(5) a later append is stored at close');
  assert.equal(text(root.readFile(path)), 'kept');
  idle.write(4, bytesOf('!'));
  takeRoom();
  assert.throws(() => idle.close(), { code: 'ENOSPC' }, '(5) close reports what storing its appends failed with');
  giveRoom();
  assert.doesNotThrow(() => other.close());
  reader.close();
  assert.equal(text(root.readFile(path)), 'kept');
}

// ── (6) 1-byte appends in a loop are stored a run at a time ──────────────────
{
  const before = handed();
  const started = performance.now();
  const r = await exec('for i in $(seq 1 3000); do printf x; done > ones.txt; wc -c < ones.txt');
  const elapsed = performance.now() - started;
  assert.equal(r.stdout.trim(), '3000');
  const amplification = (handed() - before) / 3000;
  console.log(`  3000 1-byte appends: ${elapsed.toFixed(0)} ms, the database was handed ${amplification.toFixed(2)}x`);
  // Stored once per run written (a block, 100 ms, the loop's end), not once
  // per append: each rewrote the whole growing file, 1564x on the shell's sink.
  assert.ok(amplification < 20, `(6) 1-byte appends are stored a run at a time, not one by one (${amplification.toFixed(2)}x)`);
}

// ── (7) any descriptor's fsync stores what is held for the file ────────────
{
  const path = 'home/user/synced.bin';
  vfs.as(CRED_KERNEL).writeFile(path, new Uint8Array(0));
  const writer = vfs.openDescription(path, CRED_KERNEL, { read: false, write: true });
  const reader = vfs.openDescription(path, CRED_KERNEL, { read: true, write: false });
  const before = handed();
  writer.write(0, noise(5000, 21));
  assert.equal(handed(), before, 'the append is held');
  reader.flush();
  assert.ok(handed() - before >= 5000, `(7) a read-only descriptor's fsync stores the writer's append (${handed() - before} bytes handed)`);
  writer.close();
  reader.close();
}

// ── (8) a held append keeps the time it was made ──────────────────────────
{
  const path = 'home/user/timed.txt';
  const root = vfs.as(CRED_KERNEL);
  root.writeFile(path, bytesOf('x'));
  const writer = vfs.openDescription(path, CRED_KERNEL, { read: false, write: true });
  const madeFrom = Date.now();
  writer.write(1, bytesOf('y'));
  const madeBy = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const seen = root.stat(path);
  assert.equal(seen.size, 2);
  for (const field of ['mtime', 'ctime']) {
    assert.ok(seen[field] >= madeFrom && seen[field] <= madeBy,
      `(8) ${field} is when the append was made (${madeFrom}..${madeBy}), not when a stat stored it (${seen[field]})`);
  }
  writer.close();
}

// ── (9) O_SYNC holds nothing ───────────────────────────────────────────────
{
  const memory = new MemoryVFS();
  // A backend that cannot write in place: its descriptors buffer.
  const mount = Object.assign(Object.create(memory), { writeRange: undefined });
  mount.sync = mount;
  ws.filesystem.vfs.mount('/m', mount);
  const bridge = ws.filesystem.bind({ pid: ws.shellProcessPid, cred: CRED_KERNEL });
  const synced = bridge.open('/m/sync.txt', { write: true, create: true, sync: true });
  bridge.write(synced.id, null, bytesOf('now'));
  assert.equal(text(memory.readFile('/sync.txt')), 'now', '(9) a sync descriptor on a buffering mount writes before it returns');
  const buffered = bridge.open('/m/buffered.txt', { write: true, create: true });
  bridge.write(buffered.id, null, bytesOf('later'));
  assert.equal(text(memory.readFile('/buffered.txt')), '', 'a descriptor without sync still buffers there');
  bridge.close(buffered.id);
  assert.equal(text(memory.readFile('/buffered.txt')), 'later');
  bridge.close(synced.id);

  const path = 'home/user/osync.bin';
  vfs.as(CRED_KERNEL).writeFile(path, new Uint8Array(0));
  const writer = vfs.openDescription(path, CRED_KERNEL, { read: false, write: true, sync: true });
  const before = handed();
  writer.write(0, noise(3000, 31));
  assert.ok(handed() - before >= 3000, '(9) and a sync SQLite descriptor stores each write as it is made');
  writer.close();
}

// ── (10) a watcher of a stored append writes at its own time ──────────────
{
  const root = vfs.as(CRED_KERNEL);
  const [a, b, c] = ['home/user/watched.txt', 'home/user/by-watcher.txt', 'home/user/held-by-watcher.txt'];
  root.writeFile(a, bytesOf('a'));
  root.writeFile(c, bytesOf('c'));
  const writerA = vfs.openDescription(a, CRED_KERNEL, { read: false, write: true });
  const writerC = vfs.openDescription(c, CRED_KERNEL, { read: false, write: true });
  // Watching first: subscribing is a call that stores what is held.
  let fired = null;
  const stop = root.subscribe(a, () => {
    if (fired !== null) return;
    fired = Date.now();
    root.writeFile(b, bytesOf('b'));
    writerC.write(writerC.end(), bytesOf('!'));
  });
  const madeFrom = Date.now();
  writerA.write(1, bytesOf('!'));
  const madeBy = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fired, null, 'the append is held: no event yet');
  assert.equal(root.stat(a).size, 2, 'the stat stores the held append, and its event reaches the watcher');
  stop();
  assert.ok(fired !== null, 'the watcher ran');
  assert.ok(root.stat(a).mtime <= madeBy && root.stat(a).mtime >= madeFrom, '(10) the stored append keeps its own time');
  for (const [path, what] of [[b, 'a write the watcher made'], [c, 'an append the watcher made, held and stored later']]) {
    const seen = root.stat(path);
    for (const field of ['mtime', 'ctime']) {
      assert.ok(seen[field] >= fired, `(10) ${what} has its own ${field}: ${seen[field]}, not before the watcher ran (${fired}); the stored append's is ${madeFrom}..${madeBy}`);
    }
  }
  writerA.close();
  writerC.close();
}

await ws.close();
console.log('ok - vfs-held-appends (a failed write is its command\'s, appends land in order, an abort keeps them, nothing can tell they were held)');
