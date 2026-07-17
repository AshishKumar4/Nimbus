#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { ProcessTable } from '../../packages/worker/src/runtime/process-table.ts';
import { createDefaultRegistry } from '../../packages/worker/src/substrate/lifo/commands/registry.ts';
import { registerUnixCommands } from '../../packages/worker/src/shell/unix-commands.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('etc');
root.writeFile('etc/passwd', [
  'root:x:0:0:root:/root:/bin/sh',
  'user:x:1000:1000:Nimbus User:/home/user:/bin/sh',
  '',
].join('\n'), { mode: 0o644 });
root.writeFile('etc/group', [
  'root:x:0:',
  'user:x:1000:user',
  '',
].join('\n'), { mode: 0o644 });
root.mkdir('work', { mode: 0o777 });
root.chmod('work', 0o777);

const processes = new ProcessTable();
const first = processes.spawn('sh', ['sh'], '/work');
const second = processes.spawn('sh', ['sh'], '/work');
const registry = createDefaultRegistry();
registerUnixCommands(registry, rawVfs);

async function run(name, args, pid, overrides = {}) {
  const command = await registry.resolve(name);
  assert.ok(command, `${name} is registered`);
  const cred = processes.credOf(pid);
  let stdout = '';
  let stderr = '';
  const exitCode = await command({
    args,
    cwd: '/work',
    env: {},
    pid,
    cred,
    vfs: rawVfs.as(cred),
    setUmask: (mask) => processes.setUmask(pid, mask),
    runAs: overrides.runAs ?? (async () => 0),
    stdout: { write: (value) => { stdout += String(value); } },
    stderr: { write: (value) => { stderr += String(value); } },
    signal: new AbortController().signal,
  });
  return { exitCode, stdout, stderr };
}

assert.deepEqual(await run('umask', [], first.pid), {
  exitCode: 0,
  stdout: '0022\n',
  stderr: '',
});
assert.deepEqual(await run('umask', ['-S'], first.pid), {
  exitCode: 0,
  stdout: 'u=rwx,g=rx,o=rx\n',
  stderr: '',
});
assert.deepEqual(await run('umask', ['077'], first.pid), {
  exitCode: 0,
  stdout: '',
  stderr: '',
});
assert.equal(processes.credOf(first.pid).umask, 0o077);
assert.equal(processes.credOf(second.pid).umask, 0o022,
  'umask state belongs to one process');
assert.deepEqual(await run('umask', ['-S'], first.pid), {
  exitCode: 0,
  stdout: 'u=rwx,g=,o=\n',
  stderr: '',
});

const invalid = await run('umask', ['089'], first.pid);
assert.equal(invalid.exitCode, 1);
assert.match(invalid.stderr, /invalid/i);
assert.equal(processes.credOf(first.pid).umask, 0o077,
  'an invalid mask does not mutate process state');

rawVfs.as(processes.credOf(first.pid)).writeFile('work/private', 'x');
rawVfs.as(processes.credOf(second.pid)).writeFile('work/ordinary', 'x');
assert.equal(root.stat('work/private').mode & 0o7777, 0o600);
assert.equal(root.stat('work/ordinary').mode & 0o7777, 0o644);

const invocations = [];
const runAs = async (cred, argv) => {
  invocations.push({ cred, argv });
  return 23;
};

assert.equal((await run('sudo', ['id'], first.pid, { runAs })).exitCode, 23);
assert.deepEqual(invocations.shift(), {
  cred: CRED_KERNEL,
  argv: ['id'],
}, 'sudo spawns the requested command with the root credential');

assert.equal((await run('sudo', ['-u', 'user', 'whoami'], first.pid, { runAs })).exitCode, 23);
assert.deepEqual(invocations.shift(), {
  cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o077 },
  argv: ['whoami'],
}, 'sudo -u maps the name back to the user principal and preserves process umask');

assert.equal((await run('su', ['root'], first.pid, { runAs })).exitCode, 23);
assert.deepEqual(invocations.shift(), {
  cred: CRED_KERNEL,
  argv: ['sh'],
}, 'passwordless su starts a root shell');

assert.equal((await run('su', ['user', '-c', 'whoami'], first.pid, { runAs })).exitCode, 23);
assert.deepEqual(invocations.shift(), {
  cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o077 },
  argv: ['sh', '-c', 'whoami'],
}, 'su maps a named user and runs its command through the shell');

const unknown = await run('sudo', ['-u', 'missing', 'id'], first.pid, { runAs });
assert.equal(unknown.exitCode, 1);
assert.match(unknown.stderr, /unknown user|does not exist/i);
assert.equal(invocations.length, 0, 'unknown principals never reach the spawn seam');

console.log('shell umask and elevation: ok');
