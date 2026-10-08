#!/usr/bin/env bun
/**
 * read-lease — a process's read lease (fsAcquire with `lease`): the session's
 * promise that nothing changes without the process being recalled first.
 *
 *  - It is taken by a barrier's answer, at the revision that answer reports,
 *    and confirmed by the next.
 *  - Another process's write recalls it, and is published only once the
 *    holder answered the recall (or the holder's trust in it ran out: it is
 *    never stopped for not answering). The holder's own writes recall nothing.
 *  - A holder that has not confirmed it within its trust costs a writer no wait.
 *  - The session's own stores are not leased: their synchronous writes never meet one.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { READ_LEASE_MARGIN_MS, READ_LEASE_TRUST_MS } from '../../packages/core/src/runtime/delegations.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function session() {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/d', { recursive: true });
  kernel.chown('home/user', USER.uid, USER.gid);
  kernel.chown('home/user/d', USER.uid, USER.gid);
  kernel.writeFile('home/user/d/a.txt', 'v1');
  kernel.chown('home/user/d/a.txt', USER.uid, USER.gid);
  const revoked = [];
  const files = new ProcessFiles(engine, { delegationRevoked: (event) => revoked.push(event) });
  return { engine, kernel, files, revoked };
}

/** A barrier of `bridge`'s that asks for the lease, from `from` (an answer it applied) or from now. */
function barrier(s, bridge, from) {
  return bridge.acquire(s.engine.epoch, from?.rev ?? s.engine.revision(), { lease: true });
}

// ── Taken by a barrier, at its revision; confirmed by the next ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const first = barrier(s, reader);
  assert.equal(first.poison, false);
  assert.equal(typeof first.readLease?.owner, 'string', 'a barrier that asked took no lease');
  assert.equal(first.readLease.trustMs, READ_LEASE_TRUST_MS);
  const again = barrier(s, reader);
  assert.equal(again.readLease?.owner, first.readLease.owner, 'the next barrier took another lease rather than confirm its own');
  assert.equal(s.files.delegations.stats().reads.granted, 1);
  // Not asked for: none taken, none confirmed.
  assert.equal(reader.acquire(s.engine.epoch, s.engine.revision()).readLease, undefined);
  // The engine refuses a lease at a revision behind its own.
  assert.throws(() => s.engine.acquireReadLease({ reads: false, recall: async () => {} }, { epoch: s.engine.epoch, cursor: s.engine.revision() - 1 }), (error) => error.code === 'ESTALE');
}

// ── Another's write waits for the holder's answer; the holder's own does not ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const taken = barrier(s, reader);
  const { readLease } = taken;
  // The holder's own write recalls nothing.
  await withRecall(() => reader.writeFile('/home/user/d/own.txt', 'mine'));
  assert.equal(s.files.delegations.stats().reads.answered, 0);
  // Another's: recalled, and published only after the answer.
  let published = false;
  const writing = withRecall(() => writer.writeFile('/home/user/d/a.txt', 'v2')).then(() => { published = true; });
  const kind = await reader.awaitRecall(readLease.owner, 1000);
  assert.equal(kind, 'revoke');
  await sleep(10);
  assert.equal(published, false, 'the write was published before the holder answered its recall');
  assert.equal(new TextDecoder().decode(s.kernel.readFile('home/user/d/a.txt')), 'v1');
  reader.recalled(readLease.owner, 'revoke');
  await writing;
  assert.equal(new TextDecoder().decode(s.kernel.readFile('home/user/d/a.txt')), 'v2');
  assert.equal(s.files.delegations.stats().reads.answered, 1);
  // The next barrier sees the write; recalled just now, it is leased nothing yet.
  const next = barrier(s, reader, taken);
  assert.ok(next.paths.some((entry) => entry.path === 'home/user/d/a.txt'));
  assert.equal(next.readLease, undefined);
}

// ── Recalled, a reader is leased nothing for its trust: the writer's next change waits on no one ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const { readLease } = barrier(s, reader);
  const first = withRecall(() => writer.writeFile('/home/user/d/a.txt', 'w1'));
  assert.equal(await reader.awaitRecall(readLease.owner, 1000), 'revoke');
  reader.recalled(readLease.owner, 'revoke');
  await first;
  assert.equal(barrier(s, reader).readLease, undefined, 'a reader recalled just now was leased again');
  const started = Date.now();
  await withRecall(() => writer.writeFile('/home/user/d/a.txt', 'w2'));
  assert.ok(Date.now() - started < 50, `the writer's next change waited ${Date.now() - started} ms`);
  await sleep(READ_LEASE_TRUST_MS + 20);
  assert.equal(typeof barrier(s, reader).readLease?.owner, 'string', 'a reader past the hold-off was not leased again');
}

// ── A holder that does not answer: the write waits out its trust, and no one is stopped ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  barrier(s, reader);
  const started = Date.now();
  await withRecall(() => writer.writeFile('/home/user/d/a.txt', 'v3'));
  const waited = Date.now() - started;
  assert.ok(waited >= READ_LEASE_TRUST_MS - 50, `the write waited ${waited} ms, less than the holder's trust`);
  assert.ok(waited < READ_LEASE_TRUST_MS + READ_LEASE_MARGIN_MS + 400, `the write waited ${waited} ms`);
  assert.deepEqual(s.revoked, [], 'a read lease\'s holder was stopped for not answering');
  assert.equal(s.files.delegations.stats().reads.expired, 1);
}

// ── A holder whose trust ran out already costs a writer nothing, a synchronous one included ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  barrier(s, reader);
  await sleep(READ_LEASE_TRUST_MS + READ_LEASE_MARGIN_MS + 20);
  const started = Date.now();
  await withRecall(() => writer.writeFile('/home/user/d/a.txt', 'v4'));
  assert.ok(Date.now() - started < 50, `a write waited ${Date.now() - started} ms on a lease no barrier used`);
  // The engine's own synchronous writer meets none either.
  barrier(s, reader);
  await sleep(READ_LEASE_TRUST_MS + READ_LEASE_MARGIN_MS + 20);
  s.kernel.writeFile('home/user/d/a.txt', 'v4b');
}

// ── A recall asked: the next barrier confirms nothing until it is answered ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const { readLease } = barrier(s, reader);
  const writing = withRecall(() => writer.writeFile('/home/user/d/a.txt', 'v5'));
  await sleep(5);
  assert.equal(barrier(s, reader).readLease, undefined, 'a barrier confirmed a lease whose recall is asked');
  reader.recalled(readLease.owner, 'revoke');
  await writing;
}

// ── The session's own stores are not leased ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  barrier(s, reader);
  const started = Date.now();
  s.kernel.mkdir('.nimbus/images', { recursive: true });
  s.kernel.writeFile('.nimbus/images/x', 'image');
  assert.ok(Date.now() - started < 50);
  assert.equal(s.engine.readLeaseStats().broken, 0);
}

// ── A process's waves recall another's lease before they land ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const { readLease } = barrier(s, reader);
  const { encodeWriteBatchStream } = await import('../../packages/platform/src/w7-frame.ts');
  const data = new TextEncoder().encode('waved');
  let landed = false;
  const wave = writer.writeStream(encodeWriteBatchStream({
    inodes: [{ path: 'home/user/d/w.txt', parentPath: 'home/user/d', kind: 'file', isDir: false, size: data.length, mtime: 1, mode: 0o644, chunkCount: 1 }],
    chunks: [{ path: 'home/user/d/w.txt', chunkId: 0, data }],
  })).then((result) => { landed = true; return result; });
  assert.equal(await reader.awaitRecall(readLease.owner, 1000), 'revoke');
  await sleep(10);
  assert.equal(landed, false, 'a wave landed before the holder answered');
  reader.recalled(readLease.owner, 'revoke');
  assert.equal((await wave).ok, true);
  assert.equal(s.engine.readLeaseStats().broken, 0);
}

// ── A process's wave in flight when it takes its lease is its own: it recalls nothing of it ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const { encodeWriteBatchStream } = await import('../../packages/platform/src/w7-frame.ts');
  const data = new TextEncoder().encode('own wave');
  const frames = encodeWriteBatchStream({
    inodes: [{ path: 'home/user/d/own-wave.txt', parentPath: 'home/user/d', kind: 'file', isDir: false, size: data.length, mtime: 1, mode: 0o644, chunkCount: 1 }],
    chunks: [{ path: 'home/user/d/own-wave.txt', chunkId: 0, data }],
  }).getReader();
  const go = Promise.withResolvers();
  // Begun holding nothing; its records come after the lease is taken.
  const wave = reader.writeStream(new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      await go.promise;
      const { value, done } = await frames.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  }));
  await sleep(5);
  const { readLease } = barrier(s, reader);
  go.resolve();
  const started = Date.now();
  const result = await wave;
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(Date.now() - started < 200, `the wave waited ${Date.now() - started} ms on its own lease`);
  const { reads } = s.files.delegations.stats();
  assert.deepEqual([reads.answered, reads.expired], [0, 0], 'the wave recalled its own process\'s lease');
  assert.equal(barrier(s, reader, { rev: s.engine.revision() }).readLease?.owner, readLease.owner, 'its lease did not survive its own wave');
}

// ── A lease the engine ends without waiting (a new incarnation) is recalled: its holder is told ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const { readLease } = barrier(s, reader);
  const before = s.engine.epoch;
  s.engine.rotateIncarnation();
  assert.equal(await reader.awaitRecall(readLease.owner, 200), 'revoke', 'the holder of a lease the new clock ended was not told');
  assert.equal(s.engine.readLeaseStats().broken, 1);
  reader.recalled(readLease.owner, 'revoke');
  assert.equal(reader.acquire(before, s.engine.revision(), { lease: true }).poison, true);
  assert.notEqual(barrier(s, reader).readLease?.owner, readLease.owner, 'the ended lease was confirmed again');
}

console.log('read-lease: ok');
process.exit(0);
