#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const root = engine.as(CRED_KERNEL);
root.mkdir('home/user', { recursive: true });
root.chown('home/user', USER.uid, USER.gid);
root.writeFile('home/user/regular', 'regular');
const files = sqliteFiles(engine, USER);
const namespace = new CompositeVFS(files).as(USER);
const faces = [files, namespace, namespace.sync];
const failures = [];
for (const [index, face] of faces.entries()) {
  for (const path of ['/home/user/regular', '/home/user/regular/', '/home/user/regular//']) {
    try {
      await assert.rejects(Promise.resolve().then(() => face.mkdir(path)), { code: 'EEXIST' }, `${index}: ${path}`);
      assert.equal(root.readFileString('home/user/regular'), 'regular');
    } catch (error) { failures.push(error.message); }
  }
  await assert.rejects(Promise.resolve().then(() => face.mkdir('/home/user/regular/child')), { code: 'ENOTDIR' });
  const path = `/home/user/new-${index}/`;
  await face.mkdir(path);
  assert.equal(root.isDirectory(`home/user/new-${index}`), true);
  await assert.rejects(Promise.resolve().then(() => face.mkdir(path)), { code: 'EEXIST' });
  await face.rmdir(path);
  assert.equal(root.exists(`home/user/new-${index}`), false);
}
harness.db.close();
assert.deepEqual(failures, [], failures.join('\n'));
console.log('sqlite-mkdir-directory-paths: ok');
