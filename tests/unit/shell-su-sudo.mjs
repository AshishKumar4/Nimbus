#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const rootVfs = rawVfs.as(CRED_KERNEL);

rootVfs.mkdir('etc', { recursive: true });
rootVfs.writeFile('etc/passwd', [
  'root:x:0:0:root:/root:/bin/sh',
  'user:x:1000:1000:User:/home/user:/bin/sh',
  '',
].join('\n'), { mode: 0o644 });
rootVfs.writeFile('etc/group', [
  'root:x:0:',
  'user:x:1000:user',
  '',
].join('\n'), { mode: 0o644 });

const registry = createDefaultRegistry();
registerUnixCommands(registry, rawVfs);

await assertElevation('sudo defaults to root', 'sudo', ['id'], CRED_KERNEL, ['id']);
await assertElevation('sudo -u maps a named user', 'sudo', ['-u', 'user', 'whoami'], USER, ['whoami']);
await assertElevation('su defaults to a root login shell', 'su', ['-c', 'id'], CRED_KERNEL, ['sh', '-c', 'id']);
await assertElevation('su accepts a named target user', 'su', ['user', '-c', 'whoami'], USER, ['sh', '-c', 'whoami']);

console.log('shell su and sudo: ok');

async function assertElevation(name, commandName, args, expectedCred, expectedArgv) {
  const command = await registry.resolve(commandName);
  assert.ok(command, `${commandName} is registered`);

  const calls = [];
  let stdout = '';
  let stderr = '';
  const exitCode = await command({
    args,
    pid: 51,
    cred: USER,
    cwd: '/home/user',
    env: { USER: 'user' },
    vfs: rawVfs.as(USER),
    signal: new AbortController().signal,
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
    runAs: async (cred, argv) => {
      calls.push({ cred, argv });
      return 7;
    },
  });

  assert.equal(exitCode, 7, `${name}: target exit status is returned`);
  assert.equal(stdout, '', `${name}: no fabricated output`);
  assert.equal(stderr, '', `${name}: no password prompt or error`);
  assert.deepEqual(calls, [{ cred: expectedCred, argv: expectedArgv }], `${name}: one credentialed spawn`);
}
