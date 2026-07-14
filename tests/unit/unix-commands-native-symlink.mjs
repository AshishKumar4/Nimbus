#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { registerUnixCommands } from '../../packages/worker/src/shell/unix-commands.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
vfs.mkdir('home/user/native-link', { recursive: true });
vfs.writeFile('home/user/native-link/target.txt', 'target-ok\n');
vfs.symlink('target.txt', 'home/user/native-link/link.txt');

const commands = new Map();
registerUnixCommands({ register: (name, handler) => commands.set(name, handler) }, vfs);

async function run(name, args) {
  let stdout = '';
  let stderr = '';
  const exitCode = await commands.get(name)({
    args,
    cwd: '/home/user/native-link',
    env: {},
    stdout: { write: (value) => { stdout += String(value); } },
    stderr: { write: (value) => { stderr += String(value); } },
  });
  return { exitCode, stdout, stderr };
}

assert.deepEqual(await run('readlink', ['link.txt']), {
  exitCode: 0,
  stdout: 'target.txt\n',
  stderr: '',
});
assert.deepEqual(await run('cat', ['link.txt']), {
  exitCode: 0,
  stdout: 'target-ok\n',
  stderr: '',
});
const listed = await run('ls', ['-l', 'link.txt']);
assert.equal(listed.exitCode, 0);
assert.match(listed.stdout, /^lrwxrwxrwx .* link\.txt -> target\.txt\n$/);

console.log('unix commands native symlink compatibility: ok');
