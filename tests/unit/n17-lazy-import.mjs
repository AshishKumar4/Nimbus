#!/usr/bin/env bun
// N17 end to end. A lazy import commits its rows at once and leaves the
// chunks it did not carry pending; the embedder's fetch hydrates them in the
// background.
// - An asynchronous read during the window (a process's RPC read) waits and
//   returns the bytes.
// - A synchronous read of a pending file is EIO naming it ("still being
//   imported"), never bytes, and moves its chunks to the front.
// - A launch that reads synchronously waits for the paths it names only; one
//   naming nothing pending starts at once however slow the import.
// - A fetch that never resolves fails a named launch at the deadline (fake
//   clock), with EIO naming the path.
// - Once hydration is done, no live row names a pending chunk.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL, gateSyncLaunch } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const enc = new TextEncoder();
const dec = new TextDecoder();

// The exporting side: three files, one large enough to span chunks.
const source = new SqliteVFS(...(({ sql, ctx }) => [sql, ctx])(createSqliteVfsTestHarness()));
const src = source.as(CRED_KERNEL);
src.mkdir('p', { recursive: true });
src.writeFile('p/a.txt', 'alpha');
src.writeFile('p/b.txt', 'bravo');
const big = new Uint8Array(200_000).map((_, i) => i % 251);
src.writeFile('p/big.bin', big);
source.snapshot('s');

function importing({ fetch, now, setTimer, batch }) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  engine.as(CRED_KERNEL).mkdir('home/user', { recursive: true });
  engine.as(CRED_KERNEL).chown('home/user', 1000, 1000);
  const files = new ProcessFiles(engine, { hydration: { fetch, now, setTimer, batch } });
  const page = source.exportPage({ at: 's', root: 'p' });
  const result = files.importPage('home/user/p', page, [], { lazy: true });
  assert.equal(result.done, true);
  assert.ok(result.pending.length >= 3, 'every chunk stays pending');
  return { harness, engine, files };
}
const pendingRows = (harness) => harness.sql.exec(
  'SELECT COUNT(*) AS n FROM vfs_inodes i JOIN vfs_chunks c ON c.id = i.chunk_id WHERE c.state = 2',
)[0].n + harness.sql.exec(
  'SELECT COUNT(*) AS n FROM vfs_content_chunks m JOIN vfs_chunks c ON c.id = m.chunk_id WHERE c.state = 2',
)[0].n;

// A fetch the test releases one call at a time.
function heldFetch() {
  const calls = [];
  const fetch = (hashes) => new Promise((resolve) => calls.push({ hashes, release: () => resolve(source.exportChunks(hashes, Infinity).chunks) }));
  return { fetch, calls };
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── an async read waits, then returns the bytes; a sync read is EIO ──
{
  const held = heldFetch();
  const { harness, engine, files } = importing({ fetch: held.fetch });
  const proc = files.bind({ pid: 5, cred: USER });
  assert.throws(() => proc.readFile('/home/user/p/b.txt'), (error) => error.code === 'EIO'
    && /\/home\/user\/p\/b\.txt is still being imported; its bytes arrive in the background/.test(error.message));
  // The miss moved b's chunk to the front of the job.
  assert.equal(files.hydrator.queued()[0], engine.pendingChunksOf('home/user/p/b.txt')[0]);

  const dispatch = createSupervisorOpHandler({ vfs: engine, filesystem: files });
  const reading = dispatch({ op: 'readFileBytes', args: ['/home/user/p/a.txt'], pid: 5 });
  let settled = false;
  reading.then(() => { settled = true; });
  await turn();
  assert.equal(settled, false, 'the async read waits for the bytes');
  while (held.calls.length > 0 || engine.pendingChunksOf('home/user/p/a.txt').length > 0) {
    held.calls.shift()?.release();
    await turn();
  }
  assert.equal(dec.decode(await reading), 'alpha');
  const range = await dispatch({ op: 'fsReadRange', args: ['/home/user/p/big.bin', 150_000, 10], pid: 5 });
  assert.deepEqual(range, big.subarray(150_000, 150_010));
  while (held.calls.length > 0 || files.hydrator.queued().length > 0) { held.calls.shift()?.release(); await turn(); }
  assert.equal(dec.decode(proc.readFile('/home/user/p/b.txt')), 'bravo');
  assert.equal(pendingRows(harness), 0, 'no live row names a pending chunk once hydrated');
}

// ── a launch waits for what it names, only ──
{
  const held = heldFetch();
  // One chunk a fetch, so "only what it names" is observable.
  const { engine, files } = importing({ fetch: held.fetch, batch: 1 });
  const proc = files.bind({ pid: 6, cred: USER });
  // Naming nothing imported: starts at once, while the import is stuck.
  assert.equal(await gateSyncLaunch(proc, '/home/user', null, ['-c', 'echo hi']), null);
  // Naming b.txt: waits for b, not for the rest.
  let started;
  gateSyncLaunch(proc, '/home/user/p', null, ['b.txt']).then((outcome) => { started = outcome; });
  await turn();
  assert.equal(started, undefined, 'the launch waits');
  const bChunk = engine.pendingChunksOf('home/user/p/b.txt')[0];
  assert.equal(files.hydrator.queued()[0], bChunk, 'the named path goes first');
  // The fetch already in flight when it was named, then b's: two at most
  // open it, and the rest is still pending.
  let released = 0;
  while (started === undefined && released < 2) {
    for (let i = 0; i < 5 && held.calls.length === 0; i++) await turn();
    held.calls.shift().release();
    released++;
    for (let i = 0; i < 5 && started === undefined; i++) await turn();
  }
  assert.equal(started, null, 'the gate opened (null: no error)');
  assert.ok(engine.pendingChunksOf('home/user/p/big.bin').length > 0, 'without waiting for the rest');
}

// ── a fetch that never resolves: the named launch fails at the deadline ──
{
  let now = 0;
  const timers = [];
  const { files } = importing({
    fetch: () => new Promise(() => {}),
    now: () => now,
    setTimer: (fire, ms) => { timers.push({ at: now + ms, fire }); },
  });
  const proc = files.bind({ pid: 7, cred: USER });
  let outcome;
  gateSyncLaunch(proc, '/home/user/p', null, ['a.txt']).then((message) => { outcome = message; });
  now += 29_000;
  for (const timer of timers.filter((t) => t.at <= now)) timer.fire();
  await turn();
  assert.equal(outcome, undefined, 'still waiting before the deadline');
  now += 1_000;
  for (const timer of timers.filter((t) => t.at <= now)) timer.fire();
  await turn();
  assert.equal(outcome, 'EIO: hydration of /home/user/p/a.txt did not complete in 30s');
  // Naming nothing imported still starts.
  assert.equal(await gateSyncLaunch(proc, '/home/user', null, []), null);
}

// ── an import that is not lazy is unchanged: it asks for what it lacks ──
{
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const result = engine.importPage('q', source.exportPage({ at: 's', root: 'p' }));
  assert.ok(result.want.length >= 3);
  assert.deepEqual(result.pending, []);
  assert.throws(() => new ProcessFiles(engine).importPage('r', source.exportPage({ at: 's', root: 'p' }), [], { lazy: true }), /EINVAL/);
}

// An ACQUIRE whose push roots cover a file still being imported reports it
// with its stat and bytesOmitted, as one over the push budget: the holder
// reads it on demand. The barrier does not fail.
{
  const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  engine.as(CRED_KERNEL).mkdir('home/user', { recursive: true });
  engine.as(CRED_KERNEL).chown('home/user', 1000, 1000);
  const cursor = engine.as(USER).acquire(null, 0, { namespace: true });
  const files = new ProcessFiles(engine, { hydration: { fetch: () => new Promise(() => {}), schedule: 'manual' } });
  files.importPage('home/user/p', source.exportPage({ at: 's', root: 'p' }), [], { lazy: true });
  const answer = engine.as(USER).acquire(cursor.epoch, cursor.rev, { namespace: true, push: { roots: ['/home/user'] } });
  const a = answer.paths.find((entry) => entry.path === 'home/user/p/a.txt');
  assert.ok(a, 'the file is reported');
  assert.equal(a.bytes, undefined);
  assert.equal(a.bytesOmitted, true);
  assert.equal(a.stat.size, 5);
}

console.log('n17-lazy-import: ok');
