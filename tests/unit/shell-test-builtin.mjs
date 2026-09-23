#!/usr/bin/env bun
// POSIX `test` / `[`: every unary primary, and argument-count disambiguation
// so an operand spelled like an operator stays an operand.

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
root.mkdir('/w', { mode: 0o777 });
root.chown('/w', user.uid, user.gid);
const box = await Sandbox.create({ persist: false });
registerUnixCommands(box.commands.registry, raw);
const shell = new Shell(new HeadlessTerminal(), authority, box.commands.registry,
  { HOME: '/w', PATH: '/bin', USER: 'user' }, box.shell.getProcessRegistry(),
  { pid: 78, cred: user, setUmask() {}, runAs: async () => 126 });

async function status(command) {
  const result = await shell.execute(command);
  return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function expectTrue(expr) {
  const r = await status(`[ ${expr} ]; echo "rc=$?"`);
  assert.equal(r.stdout, 'rc=0\n', `[ ${expr} ] should be true; stderr=${JSON.stringify(r.stderr)}`);
  assert.equal(r.stderr, '', `[ ${expr} ] stderr`);
}

async function expectFalse(expr) {
  const r = await status(`[ ${expr} ]; echo "rc=$?"`);
  assert.equal(r.stdout, 'rc=1\n', `[ ${expr} ] should be false; stderr=${JSON.stringify(r.stderr)}`);
  assert.equal(r.stderr, '', `[ ${expr} ] stderr`);
}

async function expectSyntaxError(command) {
  const r = await status(`${command}; echo "rc=$?"`);
  assert.equal(r.stdout, 'rc=2\n', `${command} should be a usage error`);
  assert.notEqual(r.stderr, '', `${command} should explain the error`);
}

try {
  await status('mkdir -p /w/tb/dir && printf x > /w/tb/file && : > /w/tb/empty && ln -s /w/tb/dir /w/tb/link && ln -s /w/tb/nowhere /w/tb/dangling');

  // -L / -h: symlink tests, on the link itself (a dangling link is still a link).
  await expectTrue('-L /w/tb/link');
  await expectTrue('-h /w/tb/link');
  await expectTrue('-L /w/tb/dangling');
  await expectFalse('-e /w/tb/dangling');
  await expectFalse('-L /w/tb/dir');
  await expectFalse('-L /w/tb/missing');
  await expectTrue('! -L /w/tb/dir');
  await expectTrue('-d /w/tb/link');

  // The pi.dev installer's shape: a brace group of file tests before `&&`.
  const piShape = await status('l=/w/tb/link; if { [ -e "$l" ] || [ -L "$l" ]; } && [ ! -L /w/tb/file ]; then echo yes; fi');
  assert.deepEqual(piShape, { code: 0, stdout: 'yes\n', stderr: '' });

  // A symlink-resolving loop terminates on the real file.
  const loop = await status('p=/w/tb/link; while [ -L "$p" ]; do p=$(readlink "$p"); done; echo "$p"');
  assert.deepEqual(loop, { code: 0, stdout: '/w/tb/dir\n', stderr: '' });

  // Remaining POSIX unary primaries answer instead of failing to parse.
  await expectFalse('-p /w/tb/file');
  await expectFalse('-S /w/tb/file');
  await expectFalse('-b /w/tb/file');
  await expectFalse('-u /w/tb/file');
  await expectFalse('-g /w/tb/file');
  await expectFalse('-k /w/tb/file');
  await expectTrue('-s /w/tb/file');
  await expectFalse('-s /w/tb/empty');

  // Argument count decides: an operand spelled like an operator is an operand.
  await expectTrue('-n = -n');
  await expectFalse('-z = -n');
  await expectTrue('! = !');
  await expectTrue('"(" = "("');
  await expectTrue('-e');
  await expectTrue('!');
  await expectFalse('""');
  await expectFalse('! -n');
  await expectTrue('"(" x ")"');
  await expectTrue('x -a y');
  await expectFalse('x -a ""');
  await expectTrue('"" -o y');
  await expectTrue('! -z = -n');
  await expectTrue('"(" -n x ")"');
  await expectTrue('-L /w/tb/link -a -d /w/tb/dir');

  const operand = await status('x=-n; if [ "$x" = -n ]; then echo same; fi; x="!"; if [ "$x" != ! ]; then echo bad; else echo bang; fi');
  assert.deepEqual(operand, { code: 0, stdout: 'same\nbang\n', stderr: '' });

  // `[` needs its closing `]`; `test` treats `]` as an ordinary operand.
  await expectSyntaxError('[ -n x');
  const testBracket = await status('test "]" = "]"; echo "rc=$?"');
  assert.deepEqual(testBracket, { code: 0, stdout: 'rc=0\n', stderr: '' });

  await expectSyntaxError('[ a b ]');
  await expectSyntaxError('[ a b c ]');
} finally {
  await authority.releaseProcess(78);
  box.destroy();
  harness.db.close();
}

console.log('shell-test-builtin: ok');
