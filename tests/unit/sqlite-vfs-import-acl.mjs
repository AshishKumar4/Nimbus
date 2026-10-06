#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const a = createSqliteVfsTestHarness(), b = createSqliteVfsTestHarness();
try {
  const source = new SqliteVFS(a.sql, a.ctx), src = source.as(CRED_KERNEL);
  const target = new SqliteVFS(b.sql, b.ctx), dst = target.as(CRED_KERNEL);
  src.mkdir('shared', { mode: 0o2775 }); src.chown('shared', 0, 1000);
  src.chmod('shared', 0o2775);
  source.snapshot('without-acl');
  src.setDefaultAcl('shared', 0o775);
  source.snapshot('with-acl');
  assert.equal(source.at('with-acl').getDefaultAcl('shared'), 0o775);
  const page = source.exportPage({ at: 'with-acl' });
  assert.equal(target.importPage('', page).done, true);
  assert.equal(dst.getDefaultAcl('shared'), 0o775, 'row import preserves the default ACL, not just setgid/mode');
  const writer = target.as({ uid: 1001, gid: 1000, groups: [1000], umask: 0o022 });
  writer.writeFile('shared/file', 'group-writable', { mode: 0o666 });
  assert.equal(dst.stat('shared/file').gid, 1000);
  assert.equal(dst.stat('shared/file').mode & 0o777, 0o664);
  writer.mkdir('shared/subdir');
  assert.equal(dst.getDefaultAcl('shared/subdir'), 0o775);
  assert.equal(dst.stat('shared/subdir').mode & 0o2777, 0o2775);
  assert.equal(source.diff('without-acl', 'with-acl').entries.find((entry) => entry.path === 'shared')?.change, 'modified');
  assert.notEqual(source.pageDigest({ at: 'without-acl' }).digest, source.pageDigest({ at: 'with-acl' }).digest, 'ACL-only changes invalidate page equality');
} finally { a.db.close(); b.db.close(); }
console.log('sqlite-vfs-import-acl: setgid/default ACL inheritance and ACL-only diff/page digest pass');
