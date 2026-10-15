#!/usr/bin/env bun
// fs.rmSync with `force` is quiet about a name that is gone, however late it
// goes: between the look (lstat) and the removal too, as Node's is. Here a
// mount's entries are taken by another the moment they are removed (the
// removal answers ENOENT); host Node's answer for a name that is gone is the
// expected one: nothing with force, ENOENT without.
//
// Red before: force caught ENOENT only from the lstat, so an entry gone by
// the removal threw.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { syscallError } from '../../packages/core/src/vfs/vfs-error.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

/** A mount whose every removal finds its entry already gone. */
class Vanishing extends MemoryVFS {
  unlink(path) { super.unlink(path); throw syscallError('ENOENT', 'unlink', path); }
  removeRecursive(path, policy) { super.removeRecursive(path, policy); throw syscallError('ENOENT', 'rmdir', path); }
}

const PROGRAM = (prefix) => `const fs = require('fs'); const seen = []; for (const [name, options] of [['${prefix}file', { force: true }], ['${prefix}dir', { recursive: true, force: true }], ['${prefix}file2', {}]]) { try { fs.rmSync(name, options); seen.push('ok'); } catch (e) { seen.push(e.code); } } console.log(seen.join(' '))`;

const dir = mkdtempSync(join(tmpdir(), 'rm-vanishing-'));
let expected;
try {
  // Host Node, for names that are gone: nothing is there to make.
  const r = spawnSync(process.env.NODE_BIN ?? 'node', ['-e', PROGRAM('missing-')], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  expected = r.stdout;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const mount = new Vanishing({ uid: 1000, gid: 1000 });
ws.filesystem.vfs.mount('/race', mount);
try {
  mount.writeFile('/file', 'x');
  mount.writeFile('/file2', 'x');
  mount.mkdir('/dir');
  mount.writeFile('/dir/inner', 'x');
  const ours = await ws.exec(`node -e "${PROGRAM('/race/').replaceAll('"', '\\"')}"`, { cwd: '/home/user' });
  assert.equal(ours.exitCode, 0, ours.stderr);
  assert.equal(ours.stdout, expected, 'an entry gone by its removal is, with force, no error; without, ENOENT, as Node answers for a name that is gone');
  console.log(`  ✓ rmSync with force is quiet about an entry gone by its removal (${expected.trim()})`);
} finally {
  await ws.close();
}
console.log('lifo-node-rm-vanishing: ok');
