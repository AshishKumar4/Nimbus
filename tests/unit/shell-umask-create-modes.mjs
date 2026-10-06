#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessTable } from '../../packages/core/src/runtime/process-table.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { asProcess, runCommand, unixCommandRegistry } from './lib/unix-commands.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('work', { mode: 0o777 });
root.chmod('work', 0o777);

const processes = new ProcessTable();
const privateShell = processes.spawn('sh', ['sh'], '/work');
const ordinaryShell = processes.spawn('sh', ['sh'], '/work');
const registry = unixCommandRegistry(rawVfs);
const run = (name, args, pid) => runCommand(registry, rawVfs, name, args, { cwd: '/work', ...asProcess(processes, pid) });

assert.deepEqual(await run('umask', ['077'], privateShell.pid), {
  exitCode: 0,
  stdout: '',
  stderr: '',
});
assert.equal(processes.credOf(privateShell.pid).umask, 0o077,
  'umask updates the invoking shell process');

assert.equal((await run('touch', ['private-file'], privateShell.pid)).exitCode, 0);
assert.equal((await run('mkdir', ['private-dir'], privateShell.pid)).exitCode, 0);
assert.deepEqual(
  {
    mode: root.stat('work/private-file').mode & 0o7777,
    uid: root.stat('work/private-file').uid,
    gid: root.stat('work/private-file').gid,
  },
  { mode: 0o600, uid: 1000, gid: 1000 },
  'touch applies the invoking process umask and ownership',
);
assert.deepEqual(
  {
    mode: root.stat('work/private-dir').mode & 0o7777,
    uid: root.stat('work/private-dir').uid,
    gid: root.stat('work/private-dir').gid,
  },
  { mode: 0o700, uid: 1000, gid: 1000 },
  'mkdir applies the invoking process umask and ownership',
);

assert.equal((await run('touch', ['ordinary-file'], ordinaryShell.pid)).exitCode, 0);
assert.equal((await run('mkdir', ['ordinary-dir'], ordinaryShell.pid)).exitCode, 0);
assert.equal(root.stat('work/ordinary-file').mode & 0o7777, 0o644,
  'another process keeps its default file creation mask');
assert.equal(root.stat('work/ordinary-dir').mode & 0o7777, 0o755,
  'another process keeps its default directory creation mask');

console.log('shell umask create modes: ok');
