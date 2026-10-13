#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { SqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { VfsError } from '../../packages/core/src/vfs/vfs-error.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { testBox } from './lib/test-box.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

for (const asynchronous of [false, true]) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const root = engine.as(CRED_KERNEL);
  root.mkdir('tree/blocked/nested', { recursive: true });
  root.mkdir('tree/stat-parent');
  root.mkdir('tree/vanished-dir');
  for (const dir of ['tree', 'tree/blocked', 'tree/blocked/nested', 'tree/stat-parent']) root.chown(dir, USER.uid, USER.gid);
  for (const path of ['tree/blocked/nested/secret', 'tree/stat-parent/unstatable', 'tree/free', 'tree/vanished-null', 'tree/vanished-error']) root.writeFile(path, path);
  root.chmod('tree/blocked', 0);
  let operandUnreadable = false;

  class Walked extends SqliteFiles {
    removeRecursive = undefined;
    constructor(...args) { super(...args); if (asynchronous) this.sync = undefined; }
    as(cred, actor, options) { return new Walked(engine, engine.as(cred, { ...options, actor })); }
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
        if (path === '/tree/vanished-dir') {
          root.rmdir('tree/vanished-dir');
          throw new VfsError('ENOENT', 'vanished', path);
        }
        const entries = super.readdir(path);
        if (path === '/tree' && root.exists('tree/vanished-null')) {
          root.unlink('tree/vanished-null');
          root.unlink('tree/vanished-error');
        }
        return entries;
      };
      return asynchronous ? Promise.resolve().then(read) : read();
    }
    unlink(path) {
      const remove = () => {
        if (path === '/tree/stat-parent/unstatable') throw new VfsError('EIO', 'unlink failed', path);
        return super.unlink(path);
      };
      return asynchronous ? Promise.resolve().then(remove) : remove();
    }
  }

  const namespace = new CompositeVFS(new Walked(engine, engine.as(USER)));
  const remove = () => asynchronous ? namespace.removeRecursive('/tree') : namespace.sync.removeRecursive('/tree');
  const report = await remove();
  assert.deepEqual(report.kept, ['/tree', '/tree/blocked', '/tree/stat-parent', '/tree/stat-parent/unstatable']);
  assert.deepEqual(report.removed, ['/tree/free', '/tree/vanished-dir', '/tree/vanished-error', '/tree/vanished-null']);
  assert.deepEqual(report.failures.map(({ path, error }) => [path, error.code, error.syscall, error.path]), [
    ['/tree/blocked', 'EACCES', 'scandir', '/tree/blocked'],
    ['/tree/stat-parent/unstatable', 'EIO', 'unlink', '/tree/stat-parent/unstatable'],
  ]);
  assert.equal(root.exists('tree/free'), false, 'read failures do not keep siblings');
  root.chmod('tree/blocked', 0o755);
  assert.equal(root.readFileString('tree/blocked/nested/secret'), 'tree/blocked/nested/secret');
  assert.equal(root.exists('tree/stat-parent/unstatable'), true);

  operandUnreadable = true;
  await assert.rejects(Promise.resolve().then(remove), { code: 'EACCES' }, 'the operand itself must still be stat-able');
  operandUnreadable = false;
  root.chmod('tree', 0);
  const unreadOperand = await remove();
  assert.deepEqual(unreadOperand.kept, ['/tree']);
  assert.deepEqual(unreadOperand.removed, []);
  assert.equal(unreadOperand.failures[0].error.code, 'EACCES');
  assert.equal(unreadOperand.failures[0].error.syscall, 'rmdir', 'the final rmdir is also denied by the virtual root parent');
  root.chmod('tree', 0o755);

  if (!asynchronous) {
    root.mkdir('shell/blocked', { recursive: true });
    root.chown('shell', USER.uid, USER.gid);
    root.chown('shell/blocked', USER.uid, USER.gid);
    root.writeFile('shell/free', 'free');
    root.writeFile('shell/blocked/secret', 'secret');
    root.chmod('shell/blocked', 0);
    const box = await testBox({ harness, vfs: engine, mounts: { '/walk': new Walked(engine, engine.as(USER)) } });
    try {
      const rm = await box.workspace.exec('rm -r /walk/shell');
      assert.equal(rm.exitCode, 1, 'the shell reports partial removal as failure');
      assert.ok(rm.stderr.includes('Permission denied'));
      assert.equal(root.exists('shell/free'), false, 'the real rm command continues past an unreadable sibling');
      root.chmod('shell/blocked', 0o755);
      assert.equal(root.readFileString('shell/blocked/secret'), 'secret');
    } finally {
      await box.workspace.close();
    }
  }
  harness.db.close();
}

console.log('composite-walk-removal-read-errors: ok');
