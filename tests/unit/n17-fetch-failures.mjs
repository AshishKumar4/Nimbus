#!/usr/bin/env bun
// N17 when the embedder's fetch fails. Each mode is one hydration job over a
// lazy import of two files, with a fake clock:
// - reject: every fetch rejects. Each try is retried later (backoff); after
//   the last try the chunk has failed for good, and a reader of the file gets
//   EIO naming it, the chunk and the cause, at once, as does a launch naming
//   it. Nothing is left unhandled.
// - rejectonce: the first fetch rejects; the retry brings the bytes and the
//   waiting reader gets them.
// - wrong: bytes that do not hash to their name are never stored; the chunk
//   is tried again, then failed.
// - partial: a fetch that leaves one hash out stores the rest; the one left
//   out is tried again.
// A reader waits at most the deadline, whatever the fetch does.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error));
const dec = new TextDecoder();
const source = new SqliteVFS(...(({ sql, ctx }) => [sql, ctx])(createSqliteVfsTestHarness()));
const src = source.as(CRED_KERNEL);
src.mkdir('p');
src.writeFile('p/a.txt', 'alpha');
src.writeFile('p/b.txt', 'bravo');
source.snapshot('s');

function world(fetchFor) {
  let now = 0;
  const timers = [];
  let calls = 0;
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const files = new ProcessFiles(engine, {
    hydration: {
      fetch: async (hashes) => fetchFor(++calls, hashes),
      now: () => now,
      setTimer: (fire, ms) => { timers.push({ at: now + ms, fire }); },
      maxAttempts: 3,
      backoffMs: 100,
    },
  });
  files.importPage('q', source.exportPage({ at: 's', root: 'p' }), [], { lazy: true });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  const advance = async (ms) => {
    now += ms;
    for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (timer.at <= now) timer.fire(); else timers.push(timer);
    }
    await settle();
  };
  return { engine, files, settle, advance, calls: () => calls, hash: (path) => engine.pendingChunksOf(path)[0] };
}
const outcome = (promise) => {
  const box = { state: 'waiting' };
  promise.then(() => { box.state = 'ok'; }, (error) => { box.state = error; });
  return box;
};

// ── reject: retried with backoff, then failed for good ──
{
  const w = world(() => { throw new Error('embedder down'); });
  const aChunk = w.hash('q/a.txt');
  const reader = outcome(w.files.hydrated('/q/a.txt'));
  await w.settle();
  assert.equal(w.calls(), 1);
  assert.equal(reader.state, 'waiting', 'a failed try is not the end');
  await w.advance(100);
  assert.equal(w.calls(), 2, 'tried again after the backoff');
  await w.advance(200);
  assert.equal(w.calls(), 3, 'and again, twice as late');
  assert.ok(reader.state instanceof Error, 'after the last try the reader is told');
  assert.equal(reader.state.code, 'EIO');
  assert.equal(reader.state.message, `EIO: /q/a.txt: import of chunk ${aChunk} failed: the fetch failed: embedder down`);
  // Later readers and launches are told at once.
  await assert.rejects(w.files.hydrated('/q/a.txt'), { code: 'EIO' });
  await assert.rejects(w.files.gateLaunch(['/q/a.txt']), { code: 'EIO' });
  const proc = w.files.bind({ pid: 3, cred: CRED_KERNEL });
  assert.throws(() => proc.readFile('/q/a.txt'), (error) => error.code === 'EIO' && /import of chunk .* failed/.test(error.message));
  assert.ok(w.files.hydrator.failures().has(aChunk));
  // The embedder can queue it again.
  w.files.hydrator.retryFailed();
  assert.ok(w.files.hydrator.queued().includes(aChunk));
}

// ── rejectonce: the retry brings the bytes ──
{
  const w = world((call, hashes) => {
    if (call === 1) throw new Error('transient');
    return source.exportChunks(hashes, Infinity).chunks;
  });
  const reader = outcome(w.files.hydrated('/q/a.txt'));
  await w.settle();
  assert.equal(reader.state, 'waiting');
  await w.advance(100);
  assert.equal(reader.state, 'ok');
  assert.equal(dec.decode(w.engine.as(CRED_KERNEL).readFile('q/a.txt')), 'alpha');
}

// ── wrong: never stored, retried, then failed ──
{
  const w = world((_call, hashes) => hashes.map((hash) => ({ hash, data: new TextEncoder().encode('WRONG') })));
  const reader = outcome(w.files.hydrated('/q/b.txt'));
  await w.settle();
  assert.throws(() => w.engine.as(CRED_KERNEL).readFile('q/b.txt'), { code: 'EIO' });
  await w.advance(100);
  await w.advance(200);
  assert.ok(reader.state instanceof Error);
  assert.match(reader.state.message, /failed: the bytes fetched do not hash to it$/);
}

// ── partial: the rest is stored; the one left out is tried again ──
{
  let skip = null;
  const w = world((_call, hashes) => {
    skip ??= hashes[0];
    return source.exportChunks(hashes.filter((hash) => hash !== skip), Infinity).chunks;
  });
  const both = [outcome(w.files.hydrated('/q/a.txt')), outcome(w.files.hydrated('/q/b.txt'))];
  await w.settle();
  const [first, second] = [w.engine.pendingChunksOf('q/a.txt').length, w.engine.pendingChunksOf('q/b.txt').length];
  assert.equal(first + second, 1, 'one of the two stored at once');
  skip = 'none';
  await w.advance(100);
  assert.deepEqual(both.map((box) => box.state), ['ok', 'ok']);
}

// ── a reader waits at most the deadline, whatever the fetch does ──
{
  const w = world(() => new Promise(() => {}));
  const reader = outcome(w.files.hydrated('/q/a.txt'));
  await w.advance(29_000);
  assert.equal(reader.state, 'waiting');
  await w.advance(1_000);
  assert.ok(reader.state instanceof Error);
  assert.equal(reader.state.message, 'EIO: hydration of /q/a.txt did not complete in 30s');
}

await new Promise((r) => setTimeout(r, 20));
assert.deepEqual(unhandled.map((error) => error.message), [], 'no unhandled rejection');
console.log('n17-fetch-failures: ok');
