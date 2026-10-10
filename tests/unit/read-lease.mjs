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
 *  - The session's own stores are leased too: a synchronous write to one is
 *    made at once, never refused, and published once the lease is recalled;
 *    meanwhile the process it was written for and the kernel read it.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { READ_LEASE_MARGIN_MS, READ_LEASE_TRUST_MS } from '../../packages/core/src/runtime/delegations.ts';
import { SESSION_KERNEL_ROOTS, readLeaseCovers } from '../../packages/core/src/_shared/read-lease-cover.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function session(options) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx, undefined, options);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/d', { recursive: true });
  kernel.chown('home/user', USER.uid, USER.gid);
  kernel.chown('home/user/d', USER.uid, USER.gid);
  kernel.writeFile('home/user/d/a.txt', 'v1');
  kernel.chown('home/user/d/a.txt', USER.uid, USER.gid);
  const revoked = [];
  const files = new ProcessFiles(engine, { delegationRevoked: (event) => revoked.push(event) });
  return { harness, engine, kernel, files, revoked };
}

/** A barrier of `bridge`'s that asks for the lease, from `from` (an answer it applied) or from now. */
function barrier(s, bridge, from) {
  return bridge.acquire(s.engine.epoch, from?.rev ?? s.engine.revision(), { lease: true });
}

// ── What a lease vouches for: all but its namespace's mounts, at or under them, and the names above them ──
{
  const s = session();
  s.files.vfs.mount('/mnt/drive', new MemoryVFS());
  const reader = s.files.bind({ pid: 7, cred: USER });
  const { readLease } = barrier(s, reader);
  assert.deepEqual([...readLease.uncovered].sort(), ['dev', 'mnt/drive', 'proc']);
  // A mount moves what is the engine's: the lease ends, its holder told.
  s.files.vfs.mount('/mnt/other', new MemoryVFS());
  assert.equal(await reader.awaitRecall(readLease.owner, 1000), 'revoke');
  assert.equal(s.engine.readLeaseStats().held, 0);
  // A backend with a change feed of its own (another database): its changes
  // recall no lease, so none is granted. A process's cursor follows the
  // engine's feed alone, so every barrier over another is a poison, which
  // grants none (CompositeFeed.since).
  const other = createSqliteVfsTestHarness();
  s.files.vfs.mount('/mnt/db', sqliteFiles(new SqliteVFS(other.sql, other.ctx), CRED_KERNEL));
  const fed = barrier(s, s.files.bind({ pid: 11, cred: USER }));
  assert.equal(fed.readLease, undefined, 'a lease was granted over a feed it does not follow');
  assert.equal(fed.poison, true);
  const covers = (key, listing = false) => readLeaseCovers(key, listing, readLease.uncovered);
  assert.deepEqual(['dev', 'dev/null', 'proc', 'proc/self', 'mnt/drive', 'mnt/drive/f'].filter((key) => covers(key)), []);
  assert.deepEqual(['', 'mnt'].filter((key) => covers(key, true)), []);
  assert.deepEqual(['', '.nimbus/images/x', 'var/lib/nimbus', 'devices', 'process', 'mnt', 'mnt/drive2', 'home/user/a'].filter((key) => !covers(key)), []);
  assert.deepEqual(['var', 'devices', 'home', 'mnt/other'].filter((key) => !covers(key, true)), []);
  // Where a synchronous write is held rather than refused (SqliteVFS.readRecallAt): the stores, and the directories they are made in.
  const store = (key) => !readLeaseCovers(key, true, SESSION_KERNEL_ROOTS);
  assert.deepEqual(['', 'var', 'var/lib', 'var/lib/nimbus', 'var/lib/nimbus/staged/x', '.nimbus', '.nimbus/images/x'].filter((key) => !store(key)), []);
  assert.deepEqual(['var/log', 'var/library', 'var/lib/nimbus2', '.nimbusx', 'home/user'].filter(store), []);
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
  // Committed ahead of the answer, and held: another caller that cannot wait is refused.
  assert.throws(() => s.kernel.readFile('home/user/d/a.txt'), (error) => error.code === 'EAGAIN');
  reader.recalled(readLease.owner, 'revoke');
  await writing;
  assert.equal(new TextDecoder().decode(s.kernel.readFile('home/user/d/a.txt')), 'v2');
  assert.equal(s.files.delegations.stats().reads.answered, 1);
  // The next barrier sees the write; recalled just now, it is leased nothing yet.
  const next = barrier(s, reader, taken);
  assert.ok(next.paths.some((entry) => entry.path === 'home/user/d/a.txt'));
  assert.equal(next.readLease, undefined);
}

// ── A writer that can wait commits ahead of the recall; nothing is published, or seen, before the answer ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const other = s.files.bind({ pid: 9, cred: USER });
  const taken = barrier(s, reader);
  const before = s.engine.revision();
  const seen = other.acquire(s.engine.epoch, s.engine.revision());
  let published = false;
  const writing = withRecall(() => writer.writeFile('/home/user/d/a.txt', 'piped')).then(() => { published = true; });
  assert.equal(await reader.awaitRecall(taken.readLease.owner, 1000), 'revoke');
  await sleep(10);
  // Committed, and held: no revision, no barrier reports it, no lease is granted, and another's access waits.
  assert.equal(published, false);
  assert.equal(s.engine.revision(), before, 'the write was published before the reader answered');
  const meanwhile = other.acquire(s.engine.epoch, seen.rev, { lease: true });
  assert.ok(!meanwhile.paths.some((entry) => entry.path === 'home/user/d/a.txt'), 'a barrier reported a held write');
  assert.equal(meanwhile.readLease, undefined, 'a lease was granted over a held write');
  let read = null;
  const reading = withRecall(() => other.readFile('/home/user/d/a.txt')).then((bytes) => { read = bytes; });
  assert.throws(() => other.writeFile('/home/user/d/a.txt', 'theirs'), (error) => error.code === 'EAGAIN');
  await sleep(10);
  assert.equal(read, null, 'another\'s read saw a held write');
  reader.recalled(taken.readLease.owner, 'revoke');
  await writing;
  await reading;
  assert.equal(new TextDecoder().decode(read), 'piped');
  assert.ok(s.engine.revision() > before);
  assert.ok(other.acquire(s.engine.epoch, seen.rev).paths.some((entry) => entry.path === 'home/user/d/a.txt'), 'published, a barrier reports it');
}

// ── A descriptor's writes that met a reader's recall land, and are published once it answers ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const { readLease } = barrier(s, reader);
  const held = new Set();
  const handle = await withRecall(() => writer.open('/home/user/d/log.txt', { write: true, create: true, truncate: true }), undefined, held);
  await withRecall(() => writer.write(handle.id, null, new TextEncoder().encode('started\n')), undefined, held);
  await withRecall(() => writer.fsync(handle.id), undefined, held);
  writer.close(handle.id);
  assert.equal(await reader.awaitRecall(readLease.owner, 1000), 'revoke');
  reader.recalled(readLease.owner, 'revoke');
  await Promise.all(held);
  // Past the hold-off, a reader holds a lease again: what was written is not left to a later turn.
  await sleep(READ_LEASE_TRUST_MS + 20);
  barrier(s, reader);
  await sleep(50);
  assert.equal(new TextDecoder().decode(s.kernel.readFile('home/user/d/log.txt')), 'started\n');
}

// ── The writer's own later calls pass what it holds, and its publications wait at its end ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const { readLease } = barrier(s, reader);
  const held = new Set();
  await withRecall(() => writer.writeFile('/home/user/d/a.txt', 'one'), undefined, held);
  assert.equal(held.size, 1, 'the first call held nothing for its end');
  const started = Date.now();
  await withRecall(() => writer.writeFile('/home/user/d/a.txt', 'two'), undefined, held);
  assert.ok(Date.now() - started < 50, `the writer's own second call waited ${Date.now() - started} ms on its own hold`);
  let done = false;
  const ending = Promise.all(held).then(() => { done = true; });
  await sleep(10);
  assert.equal(done, false, 'published before the reader answered');
  assert.equal(await reader.awaitRecall(readLease.owner, 1000), 'revoke');
  reader.recalled(readLease.owner, 'revoke');
  await ending;
  assert.equal(new TextDecoder().decode(s.kernel.readFile('home/user/d/a.txt')), 'two');
}

// ── Held writes acked together publish at the generations they committed: no write of their own ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const other = s.files.bind({ pid: 9, cred: USER });
  const { readLease } = barrier(s, reader);
  const from = other.acquire(s.engine.epoch, s.engine.revision());
  const held = new Set();
  await withRecall(() => writer.writeFile('/home/user/d/a.txt', 'one'), undefined, held);
  await withRecall(() => writer.writeFile('/home/user/d/b.txt', 'two'), undefined, held);
  const before = s.harness.statements.length;
  assert.equal(await reader.awaitRecall(readLease.owner, 1000), 'revoke');
  reader.recalled(readLease.owner, 'revoke');
  await Promise.all(held);
  const written = s.harness.statements.slice(before).filter((statement) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(statement.sql));
  assert.deepEqual(written.map((statement) => statement.sql), [], 'publishing what was held wrote to storage');
  const after = other.acquire(s.engine.epoch, from.rev);
  assert.deepEqual(after.paths.map((entry) => entry.path).filter((path) => path.startsWith('home/user/d/')).sort(), ['home/user/d/a.txt', 'home/user/d/b.txt']);
  assert.equal(after.rev, s.engine.revision());
}

// ── A held write is published after a later one elsewhere, at a revision of its own, kept whatever revisions are dropped ──
for (const pathRevisionBytes of [undefined, 0]) {
  const s = session({ pathRevisionBytes });
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const other = s.files.bind({ pid: 9, cred: USER });
  const { readLease } = barrier(s, reader);
  const from = other.acquire(s.engine.epoch, s.engine.revision());
  const writing = withRecall(() => writer.writeFile('/home/user/d/a.txt', 'held'));
  await sleep(10);
  // The reader's own write recalls nothing: it is published at once, ahead of the held one.
  reader.writeFile('/home/user/elsewhere', 'x');
  const later = other.acquire(s.engine.epoch, from.rev);
  assert.ok(later.paths.some((entry) => entry.path === 'home/user/elsewhere'));
  assert.ok(!later.paths.some((entry) => entry.path === 'home/user/d/a.txt'), 'the held write was reported with the later one');
  reader.recalled(readLease.owner, 'revoke');
  await writing;
  const last = other.acquire(s.engine.epoch, later.rev);
  const reported = last.paths.find((entry) => entry.path === 'home/user/d/a.txt');
  assert.ok(reported !== undefined, 'a barrier at the later write\'s revision never hears of the held one');
  assert.ok(last.rev > later.rev);
  // What the barrier reports is the revision the file has, after others' changes too, and on the next open: a read expecting it is answered.
  for (let i = 0; i < 64; i++) reader.writeFile(`/home/user/churn-${i}`, 'x');
  const fetched = other.readRange('/home/user/d/a.txt', 0, 64, { expectedEpoch: s.engine.epoch, expectedRevision: reported.rev });
  assert.equal(new TextDecoder().decode(fetched), 'held', `budget ${pathRevisionBytes}`);
  assert.equal(new SqliteVFS(s.harness.sql, s.harness.ctx).revision('home/user/d/a.txt'), reported.rev, 'the revision it was published at was not stored');
}

// ── Held for publication: a barrier's stats and pushed bytes, and a landed view's reads, wait for it; its writer's barrier sees its own ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const other = s.files.bind({ pid: 9, cred: USER });
  const from = other.acquire(s.engine.epoch, s.engine.revision());
  writer.writeFile('/home/user/d/a.txt', 'published');
  const { readLease } = barrier(s, reader);
  const writing = withRecall(() => writer.writeFile('/home/user/d/a.txt', 'held'));
  await sleep(10);
  const ask = (view) => view.acquire(s.engine.epoch, from.rev, { namespace: true, push: { roots: ['/home/user'] } });
  const decode = (bytes) => new TextDecoder().decode(bytes);
  const pushed = (answer) => answer.paths.find((entry) => entry.path === 'home/user/d/a.txt');
  assert.throws(() => ask(other), (error) => error.code === 'EAGAIN', 'a barrier reported what is held for publication');
  const landed = s.engine.as(CRED_KERNEL, { landed: true });
  assert.throws(() => landed.readFile('home/user/d/a.txt'), (error) => error.code === 'EAGAIN', 'a landed read saw what is held for publication');
  assert.equal(decode(pushed(ask(writer)).bytes), 'held', 'its writer\'s barrier waited for its own');
  reader.recalled(readLease.owner, 'revoke');
  await writing;
  const answer = await withRecall(() => ask(other));
  assert.equal(decode(pushed(answer).bytes), 'held');
  assert.equal(pushed(answer).stat.size, 4);
  assert.equal(decode(landed.readFile('home/user/d/a.txt')), 'held');
}

// ── Held for publication: another opener's description waits for it, its writer's reads its own ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const other = s.files.bind({ pid: 9, cred: USER });
  for (const name of ['b.txt', 'c.txt']) {
    s.kernel.writeFile(`home/user/d/${name}`, name);
    s.kernel.chown(`home/user/d/${name}`, USER.uid, USER.gid);
  }
  const replaced = other.open('/home/user/d/a.txt', { read: true });
  const own = writer.open('/home/user/d/a.txt', { read: true });
  const overwritten = other.open('/home/user/d/c.txt', { read: true });
  const { readLease } = barrier(s, reader);
  const held = new Set();
  await withRecall(() => writer.writeFile('/home/user/d/a.txt', 'replaced'), undefined, held);
  await withRecall(() => writer.rename('/home/user/d/b.txt', '/home/user/d/c.txt'), undefined, held);
  const decode = (bytes) => new TextDecoder().decode(bytes);
  const refused = (call, what) => assert.throws(call, (error) => error.code === 'EAGAIN', `${what} saw what is held for publication`);
  refused(() => other.read(replaced.id, 0, 64), 'a description\'s read');
  refused(() => other.fstat(replaced.id), 'a description\'s stat');
  refused(() => other.fstat(overwritten.id), 'the stat of a description a rename went over');
  assert.equal(decode(writer.read(own.id, 0, 64)), 'replaced', 'its writer\'s description read the file as before its write');
  assert.equal(await reader.awaitRecall(readLease.owner, 1000), 'revoke');
  reader.recalled(readLease.owner, 'revoke');
  await Promise.all(held);
  assert.equal(decode(other.read(replaced.id, 0, 64)), 'replaced');
  assert.equal(other.fstat(overwritten.id).nlink, 0);
  for (const [view, handle] of [[other, replaced], [writer, own], [other, overwritten]]) view.close(handle.id);
}

// ── Held for publication: its directory's names and a listing wait for it, a change beside it does not ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const other = s.files.bind({ pid: 9, cred: USER });
  s.kernel.mkdir('home/user/d/sub');
  s.kernel.chown('home/user/d/sub', USER.uid, USER.gid);
  const { readLease } = barrier(s, reader);
  const held = new Set();
  await withRecall(() => writer.writeFile('/home/user/d/made.txt', 'made'), undefined, held);
  const refused = (call, what) => assert.throws(call, (error) => error.code === 'EAGAIN', `${what} saw what is held for publication`);
  refused(() => other.readdir('/home/user/d'), 'the parent\'s names');
  refused(() => other.list(null), 'a listing');
  // Its writer sees its own.
  assert.ok(writer.readdir('/home/user/d').some((entry) => entry.name === 'made.txt'));
  // Beside the held name, the reader's own changes (they recall nothing) wait for no publication.
  reader.writeFile('/home/user/d/a.txt', 'beside');
  reader.writeFile('/home/user/d/sub/below.txt', 'below');
  assert.equal(await reader.awaitRecall(readLease.owner, 1000), 'revoke');
  reader.recalled(readLease.owner, 'revoke');
  await Promise.all(held);
  assert.deepEqual(other.readdir('/home/user/d').map((entry) => entry.name).sort(), ['a.txt', 'made.txt', 'sub']);
  assert.ok(other.list(null).entries.some((entry) => entry.path.replace(/^\/+/, '') === 'home/user/d/made.txt'));
}

// ── A retry whose commit is past an await is made again after the recall, not pipelined again ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const { readLease } = barrier(s, reader);
  let attempts = 0;
  const writing = withRecall(async () => {
    attempts++;
    await sleep(1);
    return writer.writeFile('/home/user/d/a.txt', 'later');
  });
  await sleep(20);
  assert.equal(await reader.awaitRecall(readLease.owner, 1000), 'revoke');
  reader.recalled(readLease.owner, 'revoke');
  await writing;
  assert.ok(attempts <= 3, `made ${attempts} times`);
  assert.equal(new TextDecoder().decode(s.kernel.readFile('home/user/d/a.txt')), 'later');
}

// ── A file written from a source publishes past a lease taken while it streamed: held for its recall, not refused ──
{
  const s = session();
  const size = 3 * 65536;
  let release;
  const streamed = new Promise((resolve) => { release = resolve; });
  async function* source() {
    yield new Uint8Array(size / 2).fill(1);
    await streamed;
    yield new Uint8Array(size / 2).fill(2);
  }
  // As `nimbus install` writes a runtime's blob.
  const writing = s.engine.as(USER).writeFileFrom('home/user/d/blob.wasm', size, source());
  await sleep(10);
  const reader = s.files.bind({ pid: 7, cred: USER });
  const { readLease } = barrier(s, reader);
  release();
  assert.equal(await reader.awaitRecall(readLease.owner, 1000), 'revoke', 'the publication did not recall the lease taken meanwhile');
  reader.recalled(readLease.owner, 'revoke');
  await writing;
  assert.equal(s.kernel.stat('home/user/d/blob.wasm').size, size);
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

// ── The session's stores: a synchronous write is held, not refused; the process it is for and the kernel read it, anyone else waits ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const other = s.files.bind({ pid: 9, cred: USER });
  const { readLease } = barrier(s, reader);
  const from = other.acquire(s.engine.epoch, s.engine.revision());
  // As a launch writes process 8's boot image: the kernel, through 8's binding.
  const launching = s.files.bind({ pid: 8, cred: CRED_KERNEL }).synchronous;
  launching.mkdir('/var/lib/nimbus/facet-images', { recursive: true, mode: 0o755 });
  launching.writeFile('/var/lib/nimbus/facet-images/a.js', 'image');
  const image = '/var/lib/nimbus/facet-images/a.js';
  const decode = (bytes) => new TextDecoder().decode(bytes);
  assert.equal(decode(s.files.bind({ pid: 8, cred: USER }).readFile(image)), 'image', 'the process it was written for waited');
  assert.equal(decode(s.kernel.readFile(image.slice(1))), 'image', 'the kernel waited');
  assert.throws(() => other.readFile(image), (error) => error.code === 'EAGAIN', 'another read what is held for publication');
  const root = s.files.bind({ pid: 10, cred: CRED_KERNEL });
  assert.throws(() => root.readFile(image), (error) => error.code === 'EAGAIN', 'another process, as root, read what is held for process 8');
  assert.ok(!other.acquire(s.engine.epoch, from.rev).paths.some((entry) => entry.path.startsWith('var/lib/nimbus')), 'a barrier reported it before the recall');
  assert.equal(await reader.awaitRecall(readLease.owner, 1000), 'revoke');
  reader.recalled(readLease.owner, 'revoke');
  assert.equal(decode(await withRecall(() => other.readFile(image))), 'image');
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

// ── A sequenced wave writes nothing before the recall it meets is sent, and its publication keeps its writer's own lease ──
{
  const s = session();
  const reader = s.files.bind({ pid: 7, cred: USER });
  const writer = s.files.bind({ pid: 8, cred: USER });
  const { encodeWriteBatchStream } = await import('../../packages/platform/src/w7-frame.ts');
  // A process's sequenced wave: one numbered op.
  const wave = (name, first) => writer.writeStream(encodeWriteBatchStream({
    inodes: [], chunks: [],
    ops: [{ type: 'call', call: { call: 'writeFile', path: `home/user/d/${name}`, mode: 0o644, data: new TextEncoder().encode(name) } }],
  }), { sequence: { writer: '8:w', first, ack: first - 1, pid: 8 } });
  const firstWave = await wave('first', 1);
  assert.equal(firstWave.ok, true, JSON.stringify(firstWave.error));
  // The writer reads too: its own lease.
  const own = barrier(s, writer);
  const { readLease } = barrier(s, reader);
  const begun = s.harness.statements.length;
  const second = wave('second', 2);
  assert.equal(await reader.awaitRecall(readLease.owner, 1000), 'revoke');
  const before = s.harness.statements.slice(begun).filter((statement) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(statement.sql));
  assert.deepEqual(before.map((statement) => statement.sql), [], 'the wave wrote before the recall it met was sent');
  reader.recalled(readLease.owner, 'revoke');
  const secondWave = await second;
  assert.equal(secondWave.ok, true, JSON.stringify(secondWave.error));
  assert.equal(s.engine.readLeaseStats().broken, 0, 'its publication broke its writer\'s own lease');
  assert.equal(barrier(s, writer, { rev: s.engine.revision() }).readLease?.owner, own.readLease.owner, 'the writer\'s own lease did not survive its wave');
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
