#!/usr/bin/env bun
/**
 * mv across mounts preserves mode and times best effort, as GNU mv does
 * (coreutils mv.c sets `require_preserve = false`; copy.c reports
 * "preserving times/permissions for X" and still returns success), so a
 * destination that refuses chmod or utimes gets the bytes, the source goes,
 * and mv exits 0 with a diagnostic on stderr.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/core/src/substrate/lifo/sandbox/Sandbox.ts';
import { VFSError } from '../../packages/core/src/substrate/lifo/kernel/vfs/index.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

function volume() {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  for (const dir of ['home', 'root']) {
    root.mkdir(dir, { mode: 0o755 });
    root.chown(dir, 1000, 1000);
  }
  return vfs;
}

// The kernel VFS rebinds a provider per caller through `as(cred)`.
class RefusesChmod extends SqliteVFSProvider {
  as(cred) { return new RefusesChmod(this.raw, this.prefix, cred); }
  chmod(sub) { throw new VFSError('EPERM', `'${sub}': operation not permitted`); }
}
class RefusesUtimes extends SqliteVFSProvider {
  as(cred) { return new RefusesUtimes(this.raw, this.prefix, cred); }
  utimes(sub) { throw new VFSError('EPERM', `'${sub}': operation not permitted`); }
}

const home = volume();
const box = await Sandbox.create({ persist: false });
box.kernel.vfs.mount('/home', new SqliteVFSProvider(home, 'home'));
box.kernel.vfs.mount('/nomode', new RefusesChmod(volume(), 'root'));
box.kernel.vfs.mount('/notime', new RefusesUtimes(volume(), 'root'));
registerUnixCommands(box.commands.registry, home);
const sh = line => box.shell.execute(line, {});
const exists = path => box.kernel.vfs.exists(path);

for (const [mount, what] of [['/nomode', 'permissions'], ['/notime', 'times']]) {
  await sh('echo data > /home/a.txt; mkdir -p /home/d/sub; echo n > /home/d/sub/n.txt');
  const file = await sh(`mv /home/a.txt ${mount}/a.txt`);
  assert.equal(file.exitCode, 0, `mv file into ${mount}: ${file.stderr}`);
  assert.equal(file.stderr, `mv: preserving ${what} for '${mount}/a.txt': EPERM: '/a.txt': operation not permitted\n`);
  assert.equal(new TextDecoder().decode(box.kernel.vfs.readFile(`${mount}/a.txt`)), 'data\n');
  assert.equal(exists('/home/a.txt'), false, 'the source of a completed move is removed');

  const tree = await sh(`mv /home/d ${mount}/d`);
  assert.equal(tree.exitCode, 0, `mv tree into ${mount}: ${tree.stderr}`);
  assert.equal(tree.stderr.split('\n').filter(Boolean).length, 3, tree.stderr);
  assert.equal(new TextDecoder().decode(box.kernel.vfs.readFile(`${mount}/d/sub/n.txt`)), 'n\n');
  assert.equal(exists('/home/d'), false);
}

console.log('mv-across-mounts-preserve: all assertions passed');
