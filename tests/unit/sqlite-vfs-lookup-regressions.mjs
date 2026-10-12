#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const failures = [];
function check(label, run) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const root = engine.as(CRED_KERNEL);
  root.mkdir('home/user/physical', { recursive: true });
  root.chown('home/user', USER.uid, USER.gid);
  root.chown('home/user/physical', USER.uid, USER.gid);
  const user = engine.as(USER);
  try { run({ engine, root, user }); console.log(`PASS ${label}`); }
  catch (error) { failures.push(`${label}: ${error.message}`); }
  finally { harness.db.close(); }
}

check('directory trailing slashes', ({ user }) => {
  user.mkdir('/home/user/newdir/');
  assert.equal(user.stat('/home/user/newdir/').type, 'directory');
  user.writeFile('/home/user/newdir/f', 'file');
  user.rename('/home/user/newdir/', '/home/user/renamed/');
  assert.equal(user.readFileString('/home/user/renamed/f'), 'file');
  user.unlink('/home/user/renamed/f');
  user.rmdir('/home/user/renamed/');
  assert.equal(user.exists('/home/user/renamed'), false);
  user.writeFile('/home/user/regular', 'regular');
  assert.throws(() => user.stat('/home/user/regular/'), { code: 'ENOTDIR' });
});

function privateLink({ engine, root, user }) {
  root.mkdir('var/agents/a/tmp', { recursive: true });
  root.chown('var/agents/a/tmp', USER.uid, USER.gid);
  root.chmod('var/agents/a/tmp', 0o700);
  root.writeFile('var/agents/a/tmp/f', 'private');
  engine.confinePrincipal(USER.uid, 'var/agents/a/tmp');
  user.symlink('/var/agents/a/tmp/f', '/tmp/l');
}
check('private storage-root link names', (state) => {
  privateLink(state);
  assert.equal(state.user.resolveSymlink('/tmp/l'), 'tmp/f');
});
check('private storage-root link traversal', (state) => {
  privateLink(state);
  state.root.chmod('var/agents/a', 0);
  assert.equal(state.user.readFileString('/tmp/l'), 'private');
  assert.equal(state.user.readFileString('/tmp/f'), 'private');
});

for (const path of ['hold/l/f', 'hold/l//f', 'hold/l/./f', 'hold/l/x/../f', 'hold/x/../l/f']) {
  check(`link-directory lease: ${path}`, ({ engine, root }) => {
    root.mkdir('hold/x', { recursive: true });
    root.mkdir('outside/x', { recursive: true });
    root.symlink('../outside', 'hold/l');
    root.writeFile('outside/f', 'old');
    const lease = engine.acquireExclusiveMutation('hold');
    try {
      assert.throws(() => root.writeFile(path, 'X'), { code: 'EBUSY' });
      assert.equal(root.readFileString('outside/f'), 'old');
    } finally { engine.releaseExclusiveMutation(lease.owner); }
    root.writeFile(path, 'released');
    assert.equal(root.readFileString('outside/f'), 'released');
  });
}

for (const suffix of ['//f', '/./f']) {
  check(`batch link parent: ${suffix}`, ({ user }) => {
    user.symlink('physical', 'home/user/l');
    const path = `home/user/l${suffix}`;
    user.writeBatch({
      inodes: [{ path, parentPath: 'home/user/l', isDir: false, size: 1, mtime: 1, mode: 0o644, chunkCount: 1 }],
      chunks: [{ path, chunkId: 0, data: new TextEncoder().encode('x') }],
    });
    assert.equal(user.readFileString('home/user/physical/f'), 'x');
    assert.equal(user.readFileString('home/user/l/f'), 'x');
    assert.equal(user.lstat('home/user/l').type, 'symlink');
  });
}

assert.deepEqual(failures, [], failures.join('\n'));
console.log('sqlite-vfs-lookup-regressions: ok');
