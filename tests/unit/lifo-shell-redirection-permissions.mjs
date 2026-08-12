#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/core/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('home', { mode: 0o755 });
root.mkdir('home/user', { mode: 0o755 });
root.chown('home/user', USER.uid, USER.gid);
root.writeFile('home/user/root-owned', 'original', { mode: 0o644 });

const box = await Sandbox.create({ persist: false });
let invocations = 0;

try {
  box.kernel.vfs.mount('/home', new SqliteVFSProvider(rawVfs, 'home'));
  box.commands.registry.register('mustnotrun', async () => {
    invocations++;
    return 0;
  });

  await assertRun(
    'a denied append fails only its command and preserves semicolon sequencing',
    'echo x >> /home/user/root-owned; echo AFTER=$?',
    {
      stdout: 'AFTER=1\n',
      stderr: 'sh: /home/user/root-owned: Permission denied\n',
      exitCode: 0,
    },
  );
  assert.equal(root.readFileString('home/user/root-owned'), 'original');

  await assertRun(
    'a denied append drives the OR branch',
    'echo x >> /home/user/root-owned || echo OR=$?',
    {
      stdout: 'OR=1\n',
      stderr: 'sh: /home/user/root-owned: Permission denied\n',
      exitCode: 0,
    },
  );

  invocations = 0;
  await assertRun(
    'a command body does not run when its redirect cannot open',
    'mustnotrun >> /home/user/root-owned; echo done',
    {
      stdout: 'done\n',
      stderr: 'sh: /home/user/root-owned: Permission denied\n',
      exitCode: 0,
    },
  );
  assert.equal(invocations, 0);

  await assertRun(
    'compound-command redirect failures also remain in the AND-OR chain',
    '{ mustnotrun; } > /home/user/root-owned || echo OR=$?',
    {
      stdout: 'OR=1\n',
      stderr: 'sh: /home/user/root-owned: Permission denied\n',
      exitCode: 0,
    },
  );
  assert.equal(invocations, 0);
} finally {
  box.destroy();
}

console.log('lifo shell redirection permissions: ok');

async function assertRun(name, command, expected) {
  const result = await box.shell.execute(command, {
    commandContext: { pid: 71, cred: USER },
  });
  assert.equal(result.exitCode, expected.exitCode, `${name}: exitCode`);
  assert.equal(result.stdout, expected.stdout, `${name}: stdout`);
  assert.equal(result.stderr, expected.stderr, `${name}: stderr`);
}
