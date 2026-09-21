#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { Kernel } from '../../packages/core/src/substrate/lifo/kernel/index.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';

const h = createSqliteVfsTestHarness();
const raw = new SqliteVFS(h.sql, h.ctx);
const authority = new SqliteFilesystemAuthority(raw);
const fs = authority.bind({ pid: 1, cred: CRED_KERNEL });
const bytes = text => new TextEncoder().encode(text);
const text = data => new TextDecoder().decode(data);
assert.equal(fs.synchronous, fs);
fs.writeFile('/file', 'abcdef');
const opened = fs.open('/file', { read: true, write: true });
const originalIdentity = fs.stat('/file');
assert.throws(() => fs.open('/file', { write: true, create: true, exclusive: true }), { code: 'EEXIST' });
assert.throws(() => fs.open('/file', { write: true, truncate: true, directory: true }), { code: 'ENOTDIR' });
assert.equal(text(fs.readFile('/file')), 'abcdef');
fs.mkdir('/dir');
const directory = fs.open('/dir', { read: true, directory: true });
fs.rename('/dir', '/renamed-dir');
const child = fs.open({ directory: directory.id, path: 'child' }, { write: true, create: true });
fs.write(child.id, 0, bytes('child'));
assert.equal(text(fs.readFile('/renamed-dir/child')), 'child');
assert.equal(fs.fstat(directory.id).ino, fs.stat('/renamed-dir').ino);
fs.close(child.id);
fs.close(directory.id);
const duplicate = fs.dup(opened.id);
assert.equal(text(fs.read(opened.id, null, 2)), 'ab');
assert.equal(text(fs.read(duplicate.id, null, 2)), 'cd');
fs.rename('/file', '/moved');
fs.write(opened.id, 0, bytes('AB'));
assert.equal(text(fs.readFile('/moved')), 'ABcdef');
fs.unlink('/moved');
fs.writeFile('/moved', 'replacement');
fs.close(opened.id);
assert.equal(text(fs.read(duplicate.id, 0, 6)), 'ABcdef');
assert.equal(fs.fstat(duplicate.id).ino, originalIdentity.ino);
assert.equal(fs.fstat(duplicate.id).nlink, 0);
assert.notEqual(fs.stat('/moved').ino, originalIdentity.ino);
fs.write(duplicate.id, 2, bytes('CD'));
assert.equal(text(fs.read(duplicate.id, 0, 6)), 'ABCDef');
assert.equal(text(fs.readFile('/moved')), 'replacement');
assert.equal(fs.fstat(duplicate.id).size, 6);
fs.ftruncate(duplicate.id, 3);
assert.equal(text(fs.read(duplicate.id, 0, 99)), 'ABC');
fs.close(duplicate.id);
assert.throws(() => fs.read(duplicate.id, 0, 1), { code: 'EBADF' });
const other = authority.bind({ pid: 2, cred: CRED_KERNEL });
assert.throws(() => other.read(opened.id, 0, 1), { code: 'EBADF' });
const lease1 = authority.openHost(CRED_KERNEL);
const lease2 = authority.openHost(CRED_KERNEL);
const one = lease1.fs.open('/moved', { read: true });
const two = lease2.fs.open('/moved', { read: true });
await lease1.dispose();
assert.throws(() => lease1.fs.read(one.id, 0, 1), { code: 'EBADF' });
assert.equal(text(lease2.fs.read(two.id, 0, 11)), 'replacement');
await lease2.dispose();
const listing = fs.list();
const entry = listing.entries.find(entry => entry.path === 'moved');
assert.equal(text(fs.readRange('/moved', 0, 4, { expectedEpoch: listing.epoch, expectedRevision: entry.rev })), 'repl');
fs.writeFile('/moved', 'same-length');
assert.throws(() => fs.readRange('/moved', 4, 4, { expectedEpoch: listing.epoch, expectedRevision: entry.rev }), { code: 'ESTALE' });
const reopened = new SqliteVFS(h.sql, h.ctx);
assert.equal(reopened.namespace, raw.namespace);
const afterRestart = new SqliteFilesystemAuthority(reopened).bind({ pid: 3, cred: CRED_KERNEL });
assert.throws(() => afterRestart.readRange('/moved', 0, 1, { expectedEpoch: listing.epoch, expectedRevision: entry.rev }), { code: 'ESTALE' });
await authority.releaseProcess(1);
assert.throws(() => fs.readFile('/moved'), { code: 'EBADF' });
assert.throws(() => authority.bind({ pid: 1, cred: CRED_KERNEL }), { code: 'ESTALE' });

// The same numeric pid in another logical workspace never shares append state.
const shared = createSqliteVfsTestHarness();
const a = new SqliteVFS(shared.sql, shared.ctx, 'a');
const b = new SqliteVFS(shared.sql, shared.ctx, 'b');
const writer = '11111111-1111-4111-8111-111111111111';
const moduleId = '22222222-2222-4222-8222-222222222222';
a.activateAppendWriter(7, writer);
b.activateAppendWriter(7, writer);
a.revokeAppendWritersThrough(7);
const userB = b.as(CRED_KERNEL);
userB.writeFile('/b', '');
userB.appendOnce('/b', 7, writer, moduleId, 1, 'digest', bytes('once'));
userB.appendOnce('/b', 7, writer, moduleId, 1, 'digest', bytes('once'));
assert.equal(userB.readFileString('/b'), 'once');
assert.throws(() => a.as(CRED_KERNEL).appendOnce('/a', 7, writer, moduleId, 1, 'digest', bytes('bad')), { code: 'ESTALE' });

// A closed scope rejects new work and an interrupted in-flight commit
// publishes nothing.
{
  const h2 = createSqliteVfsTestHarness();
  const raw2 = new SqliteVFS(h2.sql, h2.ctx);
  const authority2 = new SqliteFilesystemAuthority(raw2);
  const pid2 = 9;
  const proc = authority2.bind({ pid: pid2, cred: CRED_KERNEL });
  const payload = {
    inodes: [{ path: 'cancelled', parentPath: '', isDir: false, size: 3, mtime: 1, mode: 0o644, chunkCount: 1 }],
    chunks: [{ path: 'cancelled', chunkId: 0, data: bytes('abc') }],
  };
  const encoded = await (async () => {
    const reader = encodeWriteBatchStream(payload).getReader();
    const parts = [];
    for (;;) { const n = await reader.read(); if (n.done) break; parts.push(n.value); }
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  })();
  // Emit the head, then end the stream mid-frame when the scope closes: the
  // commit must fail rather than publish.
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const interrupted = new ReadableStream({
    type: 'bytes',
    pull(controller) {
      if (this.sent === undefined) {
        this.sent = true;
        controller.enqueue(encoded.slice(0, 24));
        return;
      }
      return released.then(() => controller.error(new Error('scope closed')));
    },
  });
  const commit = proc.writeStream(interrupted).then(
    (result) => ({ resolved: result }),
    (error) => ({ rejected: error }),
  );
  release();
  await authority2.releaseProcess(pid2);
  const outcome = await commit;
  assert.ok(outcome.rejected || outcome.resolved.ok === false,
    'an interrupted stream commit must not publish');
  assert.equal(raw2.as(CRED_KERNEL).exists('cancelled'), false,
    'the interrupted commit published no inode');
  // And the scope gate itself: nothing else goes through this view.
  assert.throws(() => proc.writeStream(new ReadableStream()), { code: 'EBADF' });
  h2.db.close();
}

// A kernel mount is reached only through a confined path: neither `..` nor an
// absolute path inside a capability can step out of its root sideways.
{
  const h3 = createSqliteVfsTestHarness();
  const raw3 = new SqliteVFS(h3.sql, h3.ctx);
  const kernel = new Kernel();
  kernel.initFilesystem();
  const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
  const root = raw3.as(CRED_KERNEL);
  root.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  root.chown('home/user', 1000, 1000);
  root.chown('home/user/app', 1000, 1000);
  const view = new SqliteFilesystemAuthority(raw3, kernel.vfs).bind({ pid: 9, cred: user });
  assert.equal(view.stat('/dev/null')?.type, 'file');
  assert.equal(view.readFile('/dev/null')?.byteLength, 0);
  const devNull = view.open('/dev/null', { write: true });
  assert.equal(view.write(devNull.id, null, bytes('discarded')), 9);
  view.close(devNull.id);
  assert.throws(() => view.stat({ root: 'home/user/app', path: '../../../dev/null', beneath: true }), { code: 'ENOTCAPABLE' });
  assert.throws(() => view.stat({ root: 'home/user/app', path: '/dev/null', beneath: true }), { code: 'ENOTCAPABLE' });
  const app = view.open('/home/user/app', { read: true, directory: true });
  assert.throws(() => view.readFile({ directory: app.id, path: '../../../proc/version', beneath: true }), { code: 'ENOTCAPABLE' });
  assert.throws(() => view.readFile({ directory: app.id, path: '/proc/version', beneath: true }), { code: 'ENOTCAPABLE' });
  assert.throws(() => view.rename('/home/user/app', '/dev/app'), { code: 'EXDEV' });
  view.close(app.id);

  // A denied append writes no journal row before the refusal.
  root.writeFile('home/user/private', 'x', { mode: 0o600 });
  const writer3 = '33333333-3333-4333-8333-333333333333';
  raw3.activateAppendWriter(9, writer3);
  const journal = () => [...h3.sql.exec('SELECT COUNT(*) AS n FROM vfs_append_module_state_v2')][0].n;
  const before = journal();
  assert.throws(() => view.appendOnce('/home/user/private', 9, writer3, moduleId, 1, 'digest', bytes('no')), { code: 'EACCES' });
  assert.equal(journal(), before);
  h3.db.close();
}

console.log('filesystem authority: live descriptors, namespace isolation, scoped host leases, stream cancel and epoch/version races passed');
