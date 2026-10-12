#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const root = engine.as(CRED_KERNEL);
root.mkdir('home/user/physical/child', { recursive: true });
for (const dir of ['home/user', 'home/user/physical', 'home/user/physical/child']) root.chown(dir, USER.uid, USER.gid);
root.writeFile('home/user/f', 'beside the link');
root.writeFile('home/user/physical/f', 'beside the target');
root.symlink('physical/child', 'home/user/relative');
root.symlink('/home/user/physical/child', 'home/user/absolute');
root.symlink('relative/../f', 'home/user/indirect');
const store = engine.as(USER);
const files = sqliteFiles(engine, USER);
const namespace = new CompositeVFS(files);
const decode = (bytes) => new TextDecoder().decode(bytes);

for (const link of ['relative', 'absolute']) {
  const path = `/home/user/${link}/../f`;
  assert.equal(decode(await namespace.readFile(path)), 'beside the target');
  assert.equal(store.readFileString(path), 'beside the target', 'the store walks the link before ..');
  assert.equal(decode(files.readFile(path)), 'beside the target', 'the SQLite adapter uses the same lookup');
  assert.equal(store.stat(path).ino, store.stat('/home/user/physical/f').ino);
  assert.equal(store.storageKey(path), 'home/user/physical/f');
}
assert.equal(store.readFileString('home/user/indirect'), 'beside the target', '.. inside a link target also follows preceding links');
assert.equal(store.lstat('/home/user/relative').type, 'symlink');
assert.equal(store.readlink('/home/user/relative'), 'physical/child');
assert.equal(store.readFileString('/home/user/relative//.././f'), 'beside the target');
assert.throws(() => store.readFile('/home/user/f/../f'), { code: 'ENOTDIR' }, 'a non-directory cannot be canceled by ..');
assert.throws(() => store.readFile('/home/user/missing/../f'), { code: 'ENOENT' }, 'a missing component cannot be canceled by ..');
assert.equal(store.statIfPresent('/home/user/missing/../f'), null, 'a presence lookup cannot cancel a missing component either');
root.chmod('home/user/physical/child', 0);
assert.throws(() => store.readFile('/home/user/relative/../f'), { code: 'EACCES' }, '.. must search the directory it leaves');
root.chmod('home/user/physical/child', 0o755);

store.writeFile('/home/user/relative/../new', 'created');
assert.equal(store.readFileString('/home/user/physical/new'), 'created');
assert.equal(store.exists('/home/user/new'), false);
store.mkdir('/home/user/relative/../dir');
store.symlink('f', '/home/user/relative/../last-link');
assert.equal(store.readlink('/home/user/physical/last-link'), 'f');
store.rename('/home/user/relative/../new', '/home/user/absolute/../renamed');
store.unlink('/home/user/relative/../renamed');
store.rmdir('/home/user/absolute/../dir');
assert.equal(store.exists('/home/user/physical/renamed'), false);
assert.equal(store.exists('/home/user/physical/dir'), false);

store.mkdir('/home/user/absolute/../recursive//a/b', { recursive: true });
store.mkdirBatch(['/home/user/absolute/../batch//a/b']);
assert.equal(store.isDirectory('/home/user/physical/recursive/a/b'), true);
assert.equal(store.isDirectory('/home/user/physical/batch/a/b'), true);
const staged = '/home/user/absolute/../staged';
store.writeBatch({
  inodes: [
    { path: staged, parentPath: '/home/user/absolute/..', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 },
    { path: `${staged}/f`, parentPath: staged, isDir: false, size: 6, mtime: 1, mode: 0o644, chunkCount: 1 },
  ],
  chunks: [{ path: `${staged}/f`, chunkId: 0, data: new TextEncoder().encode('staged') }],
});
assert.equal(store.readFileString('/home/user/physical/staged/f'), 'staged', 'batch-created parents use physical placement too');

engine.snapshot('before');
root.unlink('home/user/relative');
root.symlink('/home/user', 'home/user/relative');
const snapshot = engine.at('before', USER);
assert.equal(snapshot.readFileString('/home/user/relative/../f'), 'beside the target', 'snapshots walk their pinned links');
assert.equal(snapshot.storageKey('/home/user/relative/../f'), 'home/user/physical/f');
assert.deepEqual(snapshot.readdir('/home/user/relative/..'), snapshot.readdir('/home/user/physical'), 'snapshot directory lookups also use pinned links');

root.mkdir('tmp/shared/child', { recursive: true });
root.writeFile('tmp/shared/f', 'shared');
root.mkdir('var/agents/a/tmp/local/child', { recursive: true });
root.chown('var/agents/a/tmp', USER.uid, USER.gid);
root.chmod('var/agents/a/tmp', 0o700);
root.writeFile('var/agents/a/tmp/local/f', 'private');
engine.confinePrincipal(USER.uid, 'var/agents/a/tmp');
root.symlink('/tmp/local/child', 'var/agents/a/tmp/link');
assert.equal(store.readFileString('/tmp/link/../f'), 'private', 'the physical walk stays in the credentialed namespace');
assert.equal(store.readFileString('var/agents/a/tmp/link/../f'), 'private', 'storage-key spellings use the same private names');

harness.db.close();
console.log('sqlite-vfs-physical-dot-dot: ok');
