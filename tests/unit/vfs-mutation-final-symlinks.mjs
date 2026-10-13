#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const failures = [];
for (const operation of ['rmdir', 'rename', 'removeRecursive']) for (const face of ['store', 'files', 'namespace', 'sync']) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const root = engine.as(CRED_KERNEL);
  root.mkdir('home/user/physical', { recursive: true });
  root.chown('home/user', USER.uid, USER.gid);
  root.chown('home/user/physical', USER.uid, USER.gid);
  root.symlink('physical', 'home/user/l');
  const store = engine.as(USER);
  const files = sqliteFiles(engine, USER);
  const ns = new CompositeVFS(files).as(USER);
  const view = face === 'store' ? store : face === 'files' ? files : face === 'namespace' ? ns : ns.sync;
  try {
    assert.equal(store.lstat('/home/user/l/').type, 'directory', 'lstat keeps the trailing directory-follow rule');
    const run = () => operation === 'rename' ? view.rename('/home/user/l/', '/home/user/moved')
      : view[operation]('/home/user/l/');
    await assert.rejects(Promise.resolve().then(run), { code: 'ENOTDIR' }, `${face}: ${operation} does not follow its final entry`);
    assert.equal(root.lstat('home/user/l').type, 'symlink');
    assert.equal(root.stat('home/user/physical').type, 'directory');
    assert.equal(root.exists('home/user/moved'), false);
  } catch (error) { failures.push(`${face} ${operation}: ${error.message}`); }
  finally { harness.db.close(); }
}
assert.deepEqual(failures, [], failures.join('\n'));
console.log('vfs-mutation-final-symlinks: ok');
