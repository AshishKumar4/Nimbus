#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { VFS } from '../../packages/core/src/substrate/lifo/kernel/vfs/VFS.ts';
import { SqliteVFSProvider } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { evaluateTest } from '../../packages/core/src/substrate/lifo/shell/test-builtin.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const OTHER = Object.freeze({ uid: 2000, gid: 2000, groups: Object.freeze([2000]), umask: 0o022 });

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
const user = rawVfs.as(USER);

root.mkdir('etc');
root.writeFile('etc/passwd', [
  'root:x:0:0:root:/root:/bin/sh',
  'user:x:1000:1000:Nimbus User:/home/user:/bin/sh',
  '',
].join('\n'), { mode: 0o644 });
root.writeFile('etc/group', 'root:x:0:\nuser:x:1000:user\n', { mode: 0o644 });
root.mkdir('home', { mode: 0o755 });
root.mkdir('home/user', { mode: 0o755 });
root.chown('home/user', 1000, 1000);

const registry = createDefaultRegistry();
registerUnixCommands(registry, rawVfs);

async function run(name, args, cred) {
  const command = await registry.resolve(name);
  assert.ok(command, `${name} is registered`);
  let stdout = '';
  let stderr = '';
  const exitCode = await command({
    args,
    cwd: '/home/user',
    env: {},
    cred,
    pid: 1,
    vfs: rawVfs.as(cred),
    stdout: { write: (value) => { stdout += String(value); } },
    stderr: { write: (value) => { stderr += String(value); } },
    signal: new AbortController().signal,
  });
  return { exitCode, stdout, stderr };
}

user.writeFile('home/user/owned', 'owned');
const forbidden = await run('chown', ['root:root', 'owned'], USER);
assert.equal(forbidden.exitCode, 1);
assert.match(forbidden.stderr, /EPERM/,
  'changing an owned file to a foreign uid fails with EPERM');

root.mkdir('home/user/hidden', { mode: 0o700 });
root.writeFile('home/user/hidden/file', 'secret');
const untraversable = await run('chown', ['user:user', 'hidden/file'], USER);
assert.equal(untraversable.exitCode, 1);
assert.match(untraversable.stderr, /EACCES/,
  'ancestor traversal denial wins over ownership policy');

user.writeFile('home/user/access-mode', 'x');
user.chmod('home/user/access-mode', 0o400);
assert.equal((await run('test', ['-r', 'access-mode'], USER)).exitCode, 0);
assert.equal((await run('test', ['-w', 'access-mode'], USER)).exitCode, 1);
assert.equal((await run('test', ['-x', 'access-mode'], USER)).exitCode, 1);
assert.equal((await run('test', ['-w', 'access-mode'], CRED_KERNEL)).exitCode, 0,
  'root has write access regardless of mode');
assert.equal((await run('test', ['-x', 'access-mode'], CRED_KERNEL)).exitCode, 1,
  'root execute access still requires at least one execute bit');
user.chmod('home/user/access-mode', 0o001);
assert.equal((await run('test', ['-x', 'access-mode'], CRED_KERNEL)).exitCode, 0);

user.writeFile('home/user/class-binding', 'x');
user.chmod('home/user/class-binding', 0o004);
assert.equal((await run('test', ['-r', 'class-binding'], USER)).exitCode, 1,
  'the matching owner class is binding even when other grants access');
assert.equal((await run('test', ['-r', 'class-binding'], OTHER)).exitCode, 0);

const mountedVfs = new VFS();
mountedVfs.mount('/home', new SqliteVFSProvider(rawVfs, 'home'));
for (const flag of ['-e', '-f', '-d', '-s']) {
  let stderr = '';
  assert.equal(
    await evaluateTest([flag, '/home/user/hidden/file'], mountedVfs.as(USER), {
      write: (value) => { stderr += String(value); },
    }),
    1,
    `test ${flag} treats an inaccessible path as false`,
  );
  assert.equal(stderr, '', `test ${flag} does not diagnose inaccessible paths`);
}

console.log('shell access permissions: ok');
