#!/usr/bin/env bun
/**
 * mv across mounts preserves mode and times best effort, as GNU mv does
 * (coreutils mv.c sets `require_preserve = false`; copy.c reports
 * "preserving times/permissions for X" and still returns success), so a
 * destination that refuses chmod or utimes gets the bytes, the source goes,
 * and mv exits 0 with a diagnostic on stderr.
 */

import assert from 'node:assert/strict';
import { testBox } from './lib/test-box.mjs';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { VfsError } from '../../packages/core/src/vfs/vfs-error.ts';

// Mounted volumes that take bytes but refuse one kind of metadata.
class RefusesChmod extends MemoryVFS {
  chmod(path) { throw new VfsError('EPERM', 'operation not permitted', path); }
}
class RefusesUtimes extends MemoryVFS {
  utimes(path) { throw new VfsError('EPERM', 'operation not permitted', path); }
}

const box = await testBox({
  mounts: { '/nomode': new RefusesChmod({ uid: 1000, gid: 1000 }), '/notime': new RefusesUtimes({ uid: 1000, gid: 1000 }) },
});
const namespace = box.files.vfs.sync;
const sh = line => box.shell.execute(line, {});
const exists = path => namespace.stat(path) !== null;

for (const [mount, what] of [['/nomode', 'permissions'], ['/notime', 'times']]) {
  await sh('echo data > /home/user/a.txt; mkdir -p /home/user/d/sub; echo n > /home/user/d/sub/n.txt');
  const file = await sh(`mv /home/user/a.txt ${mount}/a.txt`);
  assert.equal(file.exitCode, 0, `mv file into ${mount}: ${file.stderr}`);
  assert.match(file.stderr, new RegExp(`^mv: preserving ${what} for '${mount}/a.txt': EPERM: operation not permitted`));
  assert.equal(new TextDecoder().decode(namespace.readFile(`${mount}/a.txt`)), 'data\n');
  assert.equal(exists('/home/user/a.txt'), false, 'the source of a completed move is removed');

  const tree = await sh(`mv /home/user/d ${mount}/d`);
  assert.equal(tree.exitCode, 0, `mv tree into ${mount}: ${tree.stderr}`);
  assert.equal(tree.stderr.split('\n').filter(Boolean).length, 3, tree.stderr);
  assert.equal(new TextDecoder().decode(namespace.readFile(`${mount}/d/sub/n.txt`)), 'n\n');
  assert.equal(exists('/home/user/d'), false);
}

console.log('mv-across-mounts-preserve: all assertions passed');
