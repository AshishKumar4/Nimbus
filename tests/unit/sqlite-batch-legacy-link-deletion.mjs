#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
for (const path of ['home/user/l/f', 'home/user/l/d/../f']) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const root = engine.as(CRED_KERNEL);
  root.mkdir('home/user/physical/d', { recursive: true });
  for (const dir of ['home/user', 'home/user/physical', 'home/user/physical/d']) root.chown(dir, USER.uid, USER.gid);
  root.writeFile('home/user/physical/f', 'LIVE');
  root.symlink('physical', 'home/user/l');
  harness.db.query(
    `INSERT INTO vfs_inodes (path, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, gen)
     VALUES ('home/user/l/f', 'home/user/l', 0, 0, 1, 1, 1, ?, 1000, 1000, 999999, 1)`,
  ).run(0o644);
  const legacy = () => harness.db.query("SELECT path FROM vfs_inodes WHERE path = 'home/user/l/f'").get();
  assert.ok(legacy(), 'the fixture has a stranded literal row');
  engine.as(USER).writeBatch({ inodes: [], chunks: [], deletePaths: [path] });
  if (path === 'home/user/l/f') {
    assert.equal(legacy(), null, 'a plain legacy row is deleted at its literal key');
    assert.equal(root.readFileString('home/user/physical/f'), 'LIVE', 'the reachable target is not the legacy row');
  } else {
    assert.ok(legacy(), 'a parent component never uses the lexical legacy shortcut');
    assert.equal(root.exists('home/user/physical/f'), false, 'the parent component resolves physically');
  }
  harness.db.close();
}
console.log('sqlite-batch-legacy-link-deletion: ok');
