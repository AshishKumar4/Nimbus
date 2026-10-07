#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { runCommand, unixCommandRegistry } from './lib/unix-commands.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000, 2000]), umask: 0o022 });
const encoder = new TextEncoder();
const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const rootVfs = rawVfs.as(CRED_KERNEL);
const userVfs = rawVfs.as(USER);

rootVfs.mkdir('etc', { recursive: true });
rootVfs.writeFile('etc/passwd', [
  'root:x:0:0:root:/root:/bin/sh',
  'user:x:1000:1000:User:/home/user:/bin/sh',
  '',
].join('\n'), { mode: 0o644 });
rootVfs.writeFile('etc/group', [
  'root:x:0:',
  'user:x:1000:user',
  'staff:x:2000:user',
  '',
].join('\n'), { mode: 0o644 });
rootVfs.mkdir('home/user', { recursive: true });
rootVfs.chown('home', 1000, 1000);
rootVfs.chown('home/user', 1000, 1000);
userVfs.writeFile('home/user/owned', encoder.encode('owned'));
userVfs.writeFile('home/user/lifo-owned', encoder.encode('owned'));

const registry = unixCommandRegistry(rawVfs);

{
  const result = await invoke(registry, 'chown', ['root', 'owned'], USER);
  assert.equal(result.exitCode, 1, 'a non-root owner cannot change a file uid to root');
  assert.match(result.stderr, /EPERM|Operation not permitted/i);
  assert.deepEqual(ownerOf('home/user/owned'), { uid: 1000, gid: 1000 });
}

{
  const result = await invoke(registry, 'chown', ['user:user', 'owned'], USER);
  assert.equal(result.exitCode, 0, 'an owner may chown its uid to the current uid');
  assert.deepEqual(ownerOf('home/user/owned'), { uid: 1000, gid: 1000 });
}

{
  const result = await invoke(registry, 'chown', [':staff', 'owned'], USER);
  assert.equal(result.exitCode, 0, 'an owner may select a named supplementary group');
  assert.deepEqual(ownerOf('home/user/owned'), { uid: 1000, gid: 2000 });
}

{
  const result = await invoke(registry, 'chown', ['0:0', 'owned'], CRED_KERNEL);
  assert.equal(result.exitCode, 0, 'root may use numeric uid and gid forms');
  assert.deepEqual(ownerOf('home/user/owned'), { uid: 0, gid: 0 });
}

{
  const result = await invoke(registry, 'chown', ['missing-user', 'owned'], CRED_KERNEL);
  assert.equal(result.exitCode, 1, 'unknown names fail instead of becoming uid zero');
  assert.match(result.stderr, /invalid user|unknown user/i);
}

{
  const lifoRegistry = createDefaultRegistry();
  const result = await invoke(lifoRegistry, 'chown', [':staff', 'lifo-owned'], USER);
  assert.equal(result.exitCode, 0, 'the native LIFO chown uses the same real ownership operation');
  assert.deepEqual(ownerOf('home/user/lifo-owned'), { uid: 1000, gid: 2000 });
}

{
  const userId = await invoke(registry, 'id', [], USER, { USER: 'root' });
  assert.equal(userId.stdout, 'uid=1000(user) gid=1000(user) groups=1000(user),2000(staff)\n');

  const rootId = await invoke(registry, 'id', [], CRED_KERNEL, { USER: 'user' });
  assert.equal(rootId.stdout, 'uid=0(root) gid=0(root) groups=0(root)\n');

  const whoami = await invoke(createDefaultRegistry(), 'whoami', [], CRED_KERNEL, { USER: 'user' });
  assert.equal(whoami.stdout, 'root\n', 'whoami uses the credential, not USER');
}

console.log('shell identity and chown: ok');

function ownerOf(path) {
  const stat = rootVfs.stat(path, { followSymlinks: false });
  return { uid: stat.uid, gid: stat.gid };
}

function invoke(commandRegistry, name, args, cred, env = { USER: 'user' }) {
  return runCommand(commandRegistry, rawVfs, name, args, { cred, cwd: '/home/user', env });
}
