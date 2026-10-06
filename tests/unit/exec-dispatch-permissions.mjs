#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { installPathExecResolver } from '../../packages/core/src/shell/exec-dispatch.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { CommandRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { ProcessFiles, ProcessView } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });

const harness = createSqliteVfsTestHarness();
const sqlite = new SqliteVFS(harness.sql, harness.ctx);
const root = sqlite.as(CRED_KERNEL);
root.mkdir('etc', { mode: 0o755 });
root.writeFile('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:User:/home/user:/bin/sh\n', { mode: 0o644 });
root.writeFile('etc/group', 'root:x:0:\nuser:x:1000:user\n', { mode: 0o644 });
root.mkdir('home', { mode: 0o755 });
root.mkdir('home/user', { mode: 0o755 });
root.writeFile('home/user/private.sh', '#!/bin/sh\necho private\n', { mode: 0o700 });
root.writeFile('home/user/public.sh', '#!/bin/sh\necho public\n', { mode: 0o755 });
root.mkdir('home/user/hidden', { mode: 0o700 });
root.writeFile('home/user/hidden/traversal.sh', '#!/bin/sh\necho traversal\n', { mode: 0o755 });
// A script reached through a linked directory, and a link to a script.
root.mkdir('home/user/proj', { mode: 0o755 });
root.writeFile('home/user/proj/s.sh', '#!/bin/sh\necho s\n', { mode: 0o755 });
root.symlink('proj', 'home/user/ldir');
root.symlink('proj/s.sh', 'home/user/sl.sh');

const files = new ProcessFiles(sqlite);

const registry = new CommandRegistry();
const dispatched = [];
registry.register('sh', async (ctx) => {
  dispatched.push(ctx.args[0]);
  ctx.stdout.write(`ran ${ctx.args[0]}\n`);
  return 23;
});
registerUnixCommands(registry, sqlite);
installPathExecResolver(registry, new ProcessView(files.openHost(CRED_KERNEL).fs), () => '/home/user');

async function run(path, cred, args = []) {
  const command = await registry.resolve(path);
  assert.ok(command, `${path} resolves through path exec dispatch`);
  let stdout = '';
  let stderr = '';
  const exitCode = await command({
    pid: cred.uid === 0 ? 2 : 1,
    cred,
    args,
    env: {},
    cwd: '/home/user',
    vfs: files.view({ pid: 7, cred }),
    stdout: { write: (value) => { stdout += String(value); } },
    stderr: { write: (value) => { stderr += String(value); } },
    signal: new AbortController().signal,
    setUmask() {},
    runAs: async (targetCred, targetArgv) => {
      const result = await run(targetArgv[0], targetCred, targetArgv.slice(1));
      stdout += result.stdout;
      stderr += result.stderr;
      return { status: result.exitCode, signal: null };
    },
  });
  return { exitCode, stdout, stderr };
}

const privateAsUser = await run('./private.sh', USER);
assert.equal(privateAsUser.exitCode, 126);
assert.equal(privateAsUser.stdout, '');
assert.match(privateAsUser.stderr, /Permission denied/);
assert.deepEqual(dispatched, [], 'a denied script never reaches its interpreter');

const publicAsUser = await run('./public.sh', USER);
assert.equal(publicAsUser.exitCode, 23);
assert.equal(publicAsUser.stderr, '');
assert.match(publicAsUser.stdout, /ran \/home\/user\/public\.sh/);

const hiddenAsUser = await run('./hidden/traversal.sh', USER);
assert.equal(hiddenAsUser.exitCode, 126);
assert.match(hiddenAsUser.stderr, /Permission denied/,
  'execute authorization requires traversal access on every ancestor');

const privateViaSudo = await run('sudo', USER, ['./private.sh']);
assert.equal(privateViaSudo.exitCode, 23, 'sudo can execute the root-owned 0700 script');
assert.equal(privateViaSudo.stderr, '');
assert.match(privateViaSudo.stdout, /ran \/home\/user\/private\.sh/);

// The interpreter gets the name the script was invoked by (its $0), unless
// that name is itself a link, which it gets resolved.
const throughLinkedDir = await run('./ldir/s.sh', USER);
assert.equal(throughLinkedDir.exitCode, 23, throughLinkedDir.stderr);
assert.equal(throughLinkedDir.stdout, 'ran /home/user/ldir/s.sh\n');
const throughLink = await run('./sl.sh', USER);
assert.equal(throughLink.exitCode, 23, throughLink.stderr);
assert.equal(throughLink.stdout, 'ran /home/user/proj/s.sh\n');

console.log('exec dispatch permissions: ok');
