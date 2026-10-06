#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
try {
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const plain = raw.as(CRED_KERNEL);
  plain.mkdir('a'); plain.mkdir('b'); plain.writeFile('a/file', 'old');
  const a = raw.acquireExclusiveMutation('a');
  const owned = raw.as(CRED_KERNEL, { mutationOwner: a.owner });
  let listenerError;
  const unlisten = raw.events.onPath('a/trigger', () => {
    try { plain.writeFile('a/from-listener', 'must not inherit authority'); }
    catch (error) { listenerError = error.code; }
  });
  owned.writeFile('a/trigger', 'owned event');
  assert.equal(listenerError, 'EBUSY');
  assert.equal(plain.exists('a/from-listener'), false);
  unlisten();
  assert.throws(() => plain.writeFile('a/file', 'foreign'), (e) => e.code === 'EBUSY');
  assert.throws(() => raw.as(CRED_KERNEL, { mutationOwner: 'not-a-lease' }).unlink('a/file'), (e) => e.code === 'ESTALE');
  assert.throws(() => raw.as(CRED_KERNEL, { mutationOwner: '' }).unlink('a/file'), (e) => e.code === 'ESTALE');
  assert.throws(() => owned.writeFile('b/outside', 'no'), (e) => e.code === 'EPERM');
  const b = raw.acquireExclusiveMutation('b');
  assert.throws(() => owned.writeFile('b/foreign', 'no'), (e) => e.code === 'EBUSY');
  owned.writeFile('a/file', 'owned'); owned.chmod('a/file', 0o640);
  assert.throws(() => raw.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, { mutationOwner: a.owner })
    .writeFile('a/denied', 'no'), (e) => e.code === 'EACCES', 'a lease does not grant kernel credentials');
  owned.copyFile('a/file', 'a/copy'); owned.rename('a/copy', 'a/renamed');
  owned.utimes('a/renamed', 123, 456);
  assert.equal(plain.readFileString('a/renamed'), 'owned');
  assert.equal(plain.stat('a/renamed').mtime, 456);
  raw.releaseExclusiveMutation(a.owner);
  assert.throws(() => owned.unlink('a/file'), (e) => e.code === 'ESTALE');
  raw.releaseExclusiveMutation(b.owner);

  const global = raw.acquireGlobalExclusiveMutation();
  const publisher = raw.as(CRED_KERNEL, { mutationOwner: global.owner });
  let pinned = false;
  const snapshot = raw.snapshot('after-publication', { quiesce: true }).then(() => { pinned = true; });
  await publisher.copyTreeAsync('a', 'copied');
  const data = new TextEncoder().encode('streamed');
  const frames = encodeWriteBatchStream({
    inodes: [{ path: 'streamed', parentPath: '', isDir: false, size: data.length, mode: 0o644, mtime: 1, chunkCount: 1 }],
    chunks: [{ path: 'streamed', chunkId: 0, data }],
  }).getReader();
  let releaseInput;
  const inputReady = new Promise((resolve) => { releaseInput = resolve; });
  const writing = publisher.writeStream(new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      await inputReady;
      const { value, done } = await frames.read();
      if (done) controller.close(); else controller.enqueue(value);
    },
  }));
  await Promise.resolve();
  assert.throws(() => plain.writeFile('a/file', 'escaped during await'), (e) => e.code === 'EBUSY');
  releaseInput();
  await writing;
  assert.equal(plain.readFileString('streamed'), 'streamed');
  assert.equal(plain.readFileString('copied/file'), 'owned');
  assert.equal(pinned, false, 'quiesce cannot pin while the publication lease is held');
  assert.throws(() => plain.unlink('streamed'), (e) => e.code === 'EBUSY', 'no owner leaks out of an awaited operation');
  raw.releaseExclusiveMutation(global.owner);
  await snapshot;
  assert.equal(raw.at('after-publication').readFileString('streamed'), 'streamed');
  assert.throws(() => publisher.chmod('streamed', 0o600), (e) => e.code === 'ESTALE');
} finally { harness.db.close(); }
// mkdir of a directory that is there changes nothing, so a lease refuses it
// to no one: a session's `mkdir -p` of an ancestor (its home) while a git
// command holds a repository under it, or of the lease's own root, succeeds.
{
  const leased = createSqliteVfsTestHarness();
  try {
    const raw = new SqliteVFS(leased.sql, leased.ctx);
    const kernel = raw.as(CRED_KERNEL);
    kernel.mkdir('home/user/repo/src', { recursive: true });
    const lease = raw.acquireExclusiveMutation('home/user/repo');
    kernel.mkdir('home/user', { recursive: true });
    kernel.mkdir('home/user/repo', { recursive: true });
    kernel.mkdir('home/user/repo/src', { recursive: true });
    // Making what is not there is a mutation, refused as before.
    assert.throws(() => kernel.mkdir('home/user/repo/new', { recursive: true }), (e) => e.code === 'EBUSY');
    // The holder's own mkdir -p of an existing ancestor is no write outside its root.
    raw.as(CRED_KERNEL, { mutationOwner: lease.owner }).mkdir('home/user', { recursive: true });
    raw.releaseExclusiveMutation(lease.owner);
  } finally { leased.db.close(); }
}
console.log('sqlite-vfs-owned-view: subtree/global authority, stale/foreign refusals, async ownership and quiesce pass');
