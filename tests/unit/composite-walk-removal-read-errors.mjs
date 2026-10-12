#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { SqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { VfsError } from '../../packages/core/src/vfs/vfs-error.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

for (const asynchronous of [false, true]) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const root = engine.as(CRED_KERNEL);
  root.mkdir('tree/blocked/nested', { recursive: true });
  root.mkdir('tree/stat-parent');
  for (const dir of ['tree', 'tree/blocked', 'tree/blocked/nested', 'tree/stat-parent']) root.chown(dir, USER.uid, USER.gid);
  for (const path of ['tree/blocked/nested/secret', 'tree/stat-parent/unstatable', 'tree/free', 'tree/vanished-null', 'tree/vanished-error']) root.writeFile(path, path);
  root.chmod('tree/blocked', 0);
  let operandUnreadable = false;

  class Walked extends SqliteFiles {
    removeRecursive = undefined;
    stat(path, options) {
      const read = () => {
        if (operandUnreadable && path === '/tree') throw new VfsError('EACCES', 'operand denied', path);
        if (path === '/tree/stat-parent/unstatable') throw new VfsError('EIO', 'stat failed', path);
        if (path === '/tree/vanished-error') throw new VfsError('ENOENT', 'vanished', path);
        return super.stat(path, options);
      };
      return asynchronous ? Promise.resolve().then(read) : read();
    }
    readdir(path) {
      const read = () => {
        const entries = super.readdir(path);
        if (path === '/tree' && root.exists('tree/vanished-null')) {
          root.unlink('tree/vanished-null');
          root.unlink('tree/vanished-error');
        }
        return entries;
      };
      return asynchronous ? Promise.resolve().then(read) : read();
    }
  }

  const namespace = new CompositeVFS(new Walked(engine, engine.as(USER)));
  const remove = () => asynchronous ? namespace.removeRecursive('/tree') : namespace.sync.removeRecursive('/tree');
  const report = await remove();
  assert.deepEqual(report.kept, ['/tree', '/tree/blocked', '/tree/stat-parent', '/tree/stat-parent/unstatable']);
  assert.deepEqual(report.removed, ['/tree/free', '/tree/vanished-error', '/tree/vanished-null']);
  assert.deepEqual(report.failures.map(({ path, error }) => [path, error.code, error.syscall, error.path]), [
    ['/tree/blocked', 'EACCES', 'scandir', '/tree/blocked'],
    ['/tree/stat-parent/unstatable', 'EIO', 'lstat', '/tree/stat-parent/unstatable'],
  ]);
  assert.equal(root.exists('tree/free'), false, 'read failures do not keep siblings');
  assert.equal(root.readFileString('tree/blocked/nested/secret'), 'tree/blocked/nested/secret');
  assert.equal(root.exists('tree/stat-parent/unstatable'), true);

  operandUnreadable = true;
  await assert.rejects(Promise.resolve().then(remove), { code: 'EACCES' }, 'the operand itself must still be stat-able');
  root.chmod('tree/blocked', 0o755);
  harness.db.close();
}

console.log('composite-walk-removal-read-errors: ok');
