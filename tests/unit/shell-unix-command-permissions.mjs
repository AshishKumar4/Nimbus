#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { registerUnixCommands } from '../../packages/worker/src/shell/unix-commands.ts';
import { createDefaultRegistry } from '../../packages/worker/src/substrate/lifo/commands/registry.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);

root.mkdir('etc', { mode: 0o755 });
root.writeFile('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:User:/home/user:/bin/sh\n', { mode: 0o644 });
root.writeFile('etc/group', 'root:x:0:\nuser:x:1000:user\n', { mode: 0o644 });
root.mkdir('home', { mode: 0o755 });
root.mkdir('home/user', { mode: 0o755 });
root.chown('home/user', USER.uid, USER.gid);
root.writeFile('home/user/no-access', 'NEVER', { mode: 0o000 });
root.writeFile('home/user/readable', 'VISIBLE\n', { mode: 0o644 });
root.writeFile('home/user/root-secret', 'TOPSECRET\n', { mode: 0o600 });
root.mkdir('home/user/locked', { mode: 0o755 });
root.writeFile('home/user/locked/keep', 'keep', { mode: 0o644 });
root.mkdir('home/user/hidden', { mode: 0o700 });
root.writeFile('home/user/hidden/file', 'hidden', { mode: 0o644 });

const registry = createDefaultRegistry();
registerUnixCommands(registry, rawVfs);

for (const [name, args] of [
  ['cat', ['no-access']],
  ['cat', ['root-secret']],
  ['grep', ['NEVER', 'no-access']],
  ['grep', ['TOPSECRET', 'root-secret']],
  ['base64', ['no-access']],
  ['base64', ['root-secret']],
]) {
  const result = await run(name, args, USER);
  assert.equal(result.exitCode, 1, `${name} rejects unreadable file`);
  assert.equal(result.stdout, '', `${name} does not disclose unreadable content`);
  assert.match(result.stderr, /Permission denied/, `${name} reports permission denial`);
}

const deniedRm = await run('rm', ['locked/keep'], USER);
assert.equal(deniedRm.exitCode, 1);
assert.match(deniedRm.stderr, /Permission denied/);
assert.equal(root.readFileString('home/user/locked/keep'), 'keep', 'denied rm preserves the file');

const xargsCat = await run('xargs', ['cat'], USER, rawVfs.as(USER), 'readable\n');
assert.deepEqual(xargsCat, {
  exitCode: 0,
  stdout: 'VISIBLE\n',
  stderr: '',
}, 'xargs preserves caller credentials when dispatching cat');

const deniedXargsCat = await run('xargs', ['cat'], USER, rawVfs.as(USER), 'no-access\n');
assert.equal(deniedXargsCat.exitCode, 1);
assert.equal(deniedXargsCat.stdout, '');
assert.match(deniedXargsCat.stderr, /Permission denied/);
assert.doesNotMatch(deniedXargsCat.stderr, /TypeError|undefined is not an object/);

const deniedXargsRm = await run('xargs', ['rm'], USER, rawVfs.as(USER), 'locked/keep\n');
assert.equal(deniedXargsRm.exitCode, 1);
assert.match(deniedXargsRm.stderr, /Permission denied/);
assert.doesNotMatch(deniedXargsRm.stderr, /TypeError|undefined is not an object/);
assert.equal(root.readFileString('home/user/locked/keep'), 'keep', 'xargs denied rm preserves the file');

const elevatedCat = await run('sudo', ['cat', 'root-secret'], USER);
assert.equal(elevatedCat.exitCode, 0);
assert.equal(elevatedCat.stdout, 'TOPSECRET\n');
assert.equal(elevatedCat.stderr, '');

const userVfs = rawVfs.as(USER);
const mountedVfs = {
  ...userVfs,
  readFile: (path) => path === '/dev/null' ? new Uint8Array() : userVfs.readFile(path),
};
assert.deepEqual(await run('cat', ['/dev/null'], USER, mountedVfs), {
  exitCode: 0,
  stdout: '',
  stderr: '',
}, 'cat reads mounted paths through the caller VFS');

const hiddenExists = await run('test', ['-e', 'hidden/file'], USER);
assert.equal(hiddenExists.exitCode, 1, 'test -e maps an untraversable path to false');
assert.equal(hiddenExists.stderr, '');

const missingIdentity = await runWithoutCred('cat', ['readable']);
assert.equal(missingIdentity.exitCode, 1);
assert.match(missingIdentity.stderr, /unix command dispatch requires process credentials/);
assert.doesNotMatch(missingIdentity.stderr, /TypeError|undefined is not an object/);

console.log('shell unix command permissions: ok');

async function run(name, args, cred, invocationVfs = rawVfs.as(cred), stdin = '') {
  const command = await registry.resolve(name);
  assert.ok(command, `${name} is registered`);
  let stdout = '';
  let stderr = '';
  const context = {
    args,
    cwd: '/home/user',
    env: {},
    cred,
    pid: 71,
    vfs: invocationVfs,
    stdin,
    stdout: { write: (value) => { stdout += String(value); } },
    stderr: { write: (value) => { stderr += String(value); } },
    signal: new AbortController().signal,
    setUmask: () => {},
    runAs: async (targetCred, targetArgv) => {
      const result = await run(targetArgv[0], targetArgv.slice(1), targetCred);
      stdout += result.stdout;
      stderr += result.stderr;
      return result.exitCode;
    },
  };
  const exitCode = await command(context);
  return { exitCode, stdout, stderr };
}

async function runWithoutCred(name, args) {
  const command = await registry.resolve(name);
  assert.ok(command, `${name} is registered`);
  let stdout = '';
  let stderr = '';
  const exitCode = await command({
    pid: 71,
    args,
    cwd: '/home/user',
    env: {},
    vfs: rawVfs.as(USER),
    stdout: { write: (value) => { stdout += String(value); } },
    stderr: { write: (value) => { stderr += String(value); } },
    signal: new AbortController().signal,
    setUmask: () => {},
    runAs: async () => 126,
  });
  return { exitCode, stdout, stderr };
}
