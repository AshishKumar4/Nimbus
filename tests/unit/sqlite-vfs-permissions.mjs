#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const R_OK = 4;
const W_OK = 2;
const X_OK = 1;
const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const GROUP_MEMBER = Object.freeze({ uid: 2000, gid: 2000, groups: Object.freeze([2000, 1000]), umask: 0o022 });
const OTHER = Object.freeze({ uid: 2001, gid: 2001, groups: Object.freeze([2001]), umask: 0o022 });

function makeVfs(db = new Database(':memory:')) {
  const harness = createSqliteVfsTestHarness(db);
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  return {
    db,
    harness,
    vfs,
    user: vfs.as(USER),
    root: vfs.as(CRED_KERNEL),
    group: vfs.as(GROUP_MEMBER),
    other: vfs.as(OTHER),
  };
}

function errorCode(fn, expected) {
  errorCode.count = (errorCode.count ?? 0) + 1;
  assert.throws(fn, (error) => {
    assert.equal(error?.code, expected);
    assert.match(String(error?.message), new RegExp(`^${expected}:`));
    return true;
  }, `permission assertion ${errorCode.count} expected ${expected}`);
}

// Durable uid/gid storage, defaults, and rehydration.
{
  const db = new Database(':memory:');
  const first = makeVfs(db);
  first.user.mkdir('home', { mode: 0o777 });
  first.user.writeFile('home/user-file', 'u');
  first.root.writeFile('home/root-file', 'r');
  assert.deepEqual(
    { uid: first.user.stat('home/user-file').uid, gid: first.user.stat('home/user-file').gid },
    { uid: 1000, gid: 1000 },
  );
  assert.deepEqual(
    { uid: first.root.stat('home/root-file').uid, gid: first.root.stat('home/root-file').gid },
    { uid: 0, gid: 0 },
  );

  const second = makeVfs(db);
  assert.deepEqual(
    { uid: second.root.stat('home/root-file').uid, gid: second.root.stat('home/root-file').gid },
    { uid: 0, gid: 0 },
  );
}

// First matching class is binding; root gets R/W but X requires some execute bit.
{
  const { user, root, group, other } = makeVfs();
  user.mkdir('d', { mode: 0o777 });
  user.writeFile('d/f', 'secret', { mode: 0o004 });
  errorCode(() => user.readFile('d/f'), 'EACCES');
  assert.equal(new TextDecoder().decode(other.readFile('d/f')), 'secret');
  errorCode(() => group.readFile('d/f'), 'EACCES');
  assert.equal(new TextDecoder().decode(root.readFile('d/f')), 'secret');
  errorCode(() => root.access('d/f', X_OK), 'EACCES');
  user.chmod('d/f', 0o001);
  assert.doesNotThrow(() => root.access('d/f', X_OK));
}

// Traverse denial wins over a missing leaf; stat needs traverse only, readdir needs R.
{
  const { user, root, other } = makeVfs();
  user.mkdir('private', { mode: 0o700 });
  user.writeFile('private/present', 'x', { mode: 0o000 });
  errorCode(() => other.stat('private/missing'), 'EACCES');
  errorCode(() => other.stat('private/present'), 'EACCES');
  user.chmod('private', 0o711);
  assert.equal(other.stat('private/present').size, 1);
  errorCode(() => other.readFile('private/present'), 'EACCES');
  errorCode(() => other.readdir('private'), 'EACCES');
  assert.equal(root.stat('private/present').size, 1);
  errorCode(() => other.stat('private/missing'), 'ENOENT');
}

// Creation requires W+X on the parent and applies the creating process's umask.
{
  const { vfs, user, root } = makeVfs();
  root.mkdir('owned', { mode: 0o755 });
  root.chown('owned', 1000, 1000);
  root.chmod('owned', 0o555);
  errorCode(() => user.writeFile('owned/no-write', 'x'), 'EACCES');
  root.chmod('owned', 0o733);
  const masked = { ...USER, umask: 0o077 };
  const maskedView = vfs.as(masked);
  maskedView.writeFile('owned/file', 'x');
  maskedView.mkdir('owned/dir');
  assert.equal(maskedView.stat('owned/file').mode & 0o7777, 0o600);
  assert.equal(maskedView.stat('owned/dir').mode & 0o7777, 0o700);
  maskedView.writeFile('owned/requested', 'x', { mode: 0o666 });
  assert.equal(maskedView.stat('owned/requested').mode & 0o7777, 0o600);
}

// chmod is owner-or-root (EPERM), distinct from access denials (EACCES).
{
  const { user, root, other } = makeVfs();
  user.mkdir('d', { mode: 0o777 });
  user.writeFile('d/f', 'x');
  errorCode(() => other.chmod('d/f', 0o777), 'EPERM');
  user.chmod('d', 0o700);
  errorCode(() => other.chmod('d/f', 0o777), 'EACCES');
  root.chmod('d/f', 0o400);
  assert.equal(root.stat('d/f').mode & 0o7777, 0o400);
}

// chown: self uid no-op is allowed, foreign uid is root-only, owned-group changes are allowed,
// and a successful non-root ownership operation clears setuid/setgid.
{
  const { vfs, user, root } = makeVfs();
  user.mkdir('d', { mode: 0o777 });
  user.writeFile('d/f', 'x');
  user.chown('d/f', 1000, 1000);
  errorCode(() => user.chown('d/f', 2000, null), 'EPERM');
  user.chmod('d/f', 0o6755);
  const supplementary = vfs.as({ uid: 1000, gid: 1000, groups: [1000, 2000], umask: 0o022 });
  supplementary.chown('d/f', null, 2000);
  assert.equal(supplementary.stat('d/f').gid, 2000);
  assert.equal(supplementary.stat('d/f').mode & 0o6000, 0);
  root.chown('d/f', 0, 0);
  assert.deepEqual(
    { uid: root.stat('d/f').uid, gid: root.stat('d/f').gid },
    { uid: 0, gid: 0 },
  );
}

// Explicit utimes is owner-or-root; "now" follows the write-access rule.
{
  const { user, root, other } = makeVfs();
  user.mkdir('d', { mode: 0o777 });
  user.writeFile('d/f', 'x');
  user.chmod('d/f', 0o002);
  errorCode(() => other.utimes('d/f', 1, 2), 'EPERM');
  assert.doesNotThrow(() => other.utimes('d/f', null, null));
  root.chown('d/f', 0, 0);
  assert.doesNotThrow(() => root.utimes('d/f', 3, 4));
}

// utimes follows symlinks durably and keys mutation signals to the resolved inode.
{
  const db = new Database(':memory:');
  const first = makeVfs(db);
  first.root.mkdir('d');
  first.root.writeFile('d/target', 'x');
  first.root.symlink('/d/target', 'd/link');
  const before = first.root.revision('d/target');
  const events = [];
  first.vfs.events.onPath('d/target', (event) => events.push(event.type));

  first.root.utimes('d/link', 1111, 2222);

  assert.ok(first.root.revision('d/target') > before, 'resolved target revision is bumped');
  assert.deepEqual(events, ['change'], 'resolved target emits the change event');
  const second = makeVfs(db);
  assert.deepEqual(
    { atime: second.root.stat('d/target').atime, mtime: second.root.stat('d/target').mtime },
    { atime: 1111, mtime: 2222 },
    'resolved target timestamps survive VFS rehydration',
  );
}

// Boolean probes answer resolution failures as false — fs.existsSync
// semantics. Module resolvers probe paths THROUGH files
// (`lib.js/index.js`, `entry.js/package.json`); the legacy map-lookup
// exists() answered false, so a throwing probe is a regression that
// killed every barrel pre-bundle (ENOTDIR aborted the slice walk).
// Real reads keep failing honestly, and permission denials still throw
// so traverse enforcement cannot be masked into a quiet false.
{
  const { user, other } = makeVfs();
  user.mkdir('home', { mode: 0o755 });
  user.writeFile('home/lib.js', 'export {}');
  assert.equal(user.exists('home/lib.js/index.js'), false, 'exists through a file answers false');
  assert.equal(user.isDirectory('home/lib.js/index.js'), false, 'isDirectory through a file answers false');
  assert.equal(user.isFile('home/lib.js/index.js'), false, 'isFile through a file answers false');
  assert.equal(user.isSymlink('home/lib.js/index.js'), false, 'isSymlink through a file answers false');
  assert.equal(user.exists('home/no-such-dir/index.js'), false, 'exists under a missing dir answers false');
  errorCode(() => user.readFile('home/lib.js/index.js'), 'ENOTDIR');
  user.mkdir('home/p700', { mode: 0o700 });
  user.writeFile('home/p700/leaf', 'x');
  errorCode(() => other.exists('home/p700/leaf'), 'EACCES');
}

console.log('sqlite-vfs-permissions: all assertions passed');
