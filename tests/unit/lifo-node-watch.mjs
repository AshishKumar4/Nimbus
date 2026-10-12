#!/usr/bin/env bun
/**
 * The shell's built-in node's fs.watch hears the process's namespace
 * (VFS-2b), as Node's does: 'rename' when an entry appears or goes,
 * 'change' when one changes, named from the watched directory (its direct
 * entries; any depth when recursive) or as the watched file, and nothing
 * once closed. It watched the whole filesystem coarsely, through a watch of
 * the root that never fired; a program that watches stays until it closes
 * its watch, as Node keeps it.
 */

import assert from 'node:assert/strict';
import { createFs } from '../../packages/core/src/substrate/lifo/node-compat/fs.ts';
import { synchronousFilesystem } from '../../packages/core/src/substrate/lifo/node-compat/filesystem.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { hostSqlite } from './lib/host-sqlite.mjs';

const failed = [];
const check = async (name, run) => {
  try { await run(); } catch (error) { failed.push(`${name}: ${String(error?.message ?? error).split('\n').slice(0, 4).join(' | ')}`); }
};

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = rawVfs.as(CRED_KERNEL);
kernel.mkdir('w/d', { recursive: true });
kernel.writeFile('w/watched.txt', 'w');
const files = new ProcessFiles(rawVfs);
const fs = createFs(synchronousFilesystem({ process: files.bind({ pid: 4301, cred: CRED_KERNEL }) })(), '/');
const hearing = (path, options) => {
  const heard = [];
  const watcher = fs.watch(path, options ?? {}, (type, name) => heard.push(`${type} ${name}`));
  return { heard, watcher };
};

await check('a directory\'s direct entries, as Node names them', () => {
  const { heard, watcher } = hearing('/w');
  kernel.writeFile('w/a.txt', 'a');
  kernel.writeFile('w/a.txt', 'b');
  kernel.writeFile('w/d/deep.txt', 'deep');
  kernel.rename('w/a.txt', 'w/b.txt');
  kernel.unlink('w/b.txt');
  kernel.writeFile('elsewhere.txt', 'e');
  watcher.close();
  kernel.writeFile('w/after-close.txt', 'c');
  assert.deepEqual(heard, ['rename a.txt', 'change a.txt', 'rename a.txt', 'rename b.txt', 'rename b.txt']);
});

await check('recursive: every entry under it, named from it', () => {
  const { heard, watcher } = hearing('/w', { recursive: true });
  kernel.writeFile('w/d/deeper.txt', 'x');
  watcher.close();
  assert.deepEqual(heard, ['rename d/deeper.txt']);
});

await check('a file: itself, by its own name', () => {
  const { heard, watcher } = hearing('/w/watched.txt');
  kernel.writeFile('w/watched.txt', 'changed');
  kernel.writeFile('w/other.txt', 'o');
  watcher.close();
  assert.deepEqual(heard, ['change watched.txt']);
});

await check('a node program that watches hears its own writes, and stays until it closes the watch', async () => {
  const { sql, transactions } = await hostSqlite();
  const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
  await ws.fs.mkdir('/home/user/w', { recursive: true });
  await ws.fs.writeFile('/home/user/watch.js', [
    "const fs = require('fs');",
    "const seen = [];",
    "const watcher = fs.watch('/home/user/w', (type, name) => {",
    "  seen.push(type + ' ' + name);",
    "  if (name === 'b.txt') { watcher.close(); console.log(seen.join(',')); }",
    "});",
    "fs.writeFileSync('/home/user/w/a.txt', 'a');",
    "fs.writeFileSync('/home/user/w/b.txt', 'b');",
  ].join('\n'));
  const run = await ws.exec('node watch.js', { cwd: '/home/user' });
  assert.equal(run.stdout, 'rename a.txt,rename b.txt\n', run.stderr);
  assert.equal(run.exitCode, 0);
});

if (failed.length > 0) {
  console.error(failed.join('\n'));
  process.exit(1);
}
console.log('lifo-node-watch: ok');
