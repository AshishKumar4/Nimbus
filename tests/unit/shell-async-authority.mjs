#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';
import { Sandbox } from '../../packages/core/src/substrate/lifo/sandbox/Sandbox.ts';
import { HeadlessTerminal } from '../../packages/core/src/substrate/lifo/sandbox/HeadlessTerminal.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const authority = new SqliteFilesystemAuthority(raw);
const root = raw.as(CRED_KERNEL);
const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
root.mkdir('/remote', { mode: 0o777 });
root.chown('/remote', user.uid, user.gid);
root.writeFile('/remote/first', 'remote data');
root.writeFile('/remote/secret', 'SECRET', { mode: 0o600 });
root.mkdir('/remote/locked', { mode: 0o700 });
root.symlink('/remote/locked', '/remote/link');
const calls = [];
let failWrites = false;
function delayed(view) {
  return new Proxy(view, {
    get(target, key) {
      if (key === 'synchronous') return undefined;
      const member = target[key];
      if (typeof member !== 'function') return member;
      return async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 1));
        if (failWrites && key === 'write') throw Object.assign(new Error('remote write failed'), { code: 'EIO' });
        const result = await member.apply(target, args);
        calls.push([key, args[0]]);
        return result;
      };
    },
  });
}
const remote = {
  namespace: authority.namespace,
  bind: binding => delayed(authority.bind(binding)),
  openHost(cred, options) { const lease = authority.openHost(cred, options); return { fs: delayed(lease.fs), dispose: () => lease.dispose() }; },
  releaseProcess: pid => authority.releaseProcess(pid),
};
const box = await Sandbox.create({ persist: false });
registerUnixCommands(box.commands.registry, raw);
const shell = new Shell(new HeadlessTerminal(), remote, box.commands.registry,
  { HOME: '/remote', PATH: '/bin', USER: 'user' }, box.shell.getProcessRegistry(),
  { pid: 77, cred: user, setUmask() {}, runAs: async () => 126 });
try {
  const result = await shell.execute('cd /remote; cat first; printf changed > second; cat < second; [ -f second ] && echo FILE; [ -d second ] || echo NOTDIR; printf "%s\n" /remote/s*');
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /remote datachangedFILE\nNOTDIR\n/);
  assert.match(result.stdout, /\/remote\/second/);
  assert.equal(root.readFileString('/remote/second'), 'changed');
  assert.equal(box.kernel.vfs.exists('/remote/second'), false, 'no mirrored file in the standalone store');
  const denied = await shell.execute('cat /remote/secret; printf leak > /remote/link/leak');
  assert.notEqual(denied.exitCode, 0);
  assert.ok(!denied.stdout.includes('SECRET'));
  assert.equal(root.exists('/remote/locked/leak'), false);
  // The in-process Node interpreter demands a synchronous capability only
  // when a program reaches for fs; the script itself is read asynchronously.
  root.writeFile('/remote/hello.js', 'console.log("hello from a file")');
  root.writeFile('/remote/touches-fs.js', 'require("fs").readFileSync("/remote/first")');
  const evaluated = await shell.execute('node -e "console.log(1 + 1)"; node /remote/hello.js');
  assert.equal(evaluated.exitCode, 0, evaluated.stderr);
  assert.equal(evaluated.stdout, '2\nhello from a file\n');
  const missing = await shell.execute('node /remote/nope.js');
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /^node: \/remote\/nope\.js: No such file or directory/);
  const needsSync = await shell.execute('node /remote/touches-fs.js');
  assert.equal(needsSync.exitCode, 1);
  assert.match(needsSync.stderr, /synchronous filesystem capability/);
  failWrites = true;
  const failed = await shell.execute('printf data > /remote/failure');
  assert.notEqual(failed.exitCode, 0);
  assert.match(failed.stderr, /remote write failed/);
  assert.equal(calls.filter(([method]) => method === 'open').length,
    calls.filter(([method]) => method === 'close').length, 'redirection descriptors close on success and failure');
  console.log('shell async authority: reads, writes, redirections, cwd, predicates, glob, denials and write failures passed');
} finally {
  await authority.releaseProcess(77);
  box.destroy();
  harness.db.close();
}
