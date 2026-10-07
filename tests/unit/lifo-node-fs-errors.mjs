#!/usr/bin/env bun
/**
 * The errors the shell's built-in node (lifo node-compat/fs.ts) throws for
 * a filesystem call that fails are Node's: the same code, errno, syscall,
 * path and message as real Node's fs gives for the same call on the same
 * tree, sync and callback alike (one error shape, core vfs/vfs-error.ts).
 */

import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFs } from '../../packages/core/src/substrate/lifo/node-compat/fs.ts';
import { synchronousFilesystem } from '../../packages/core/src/substrate/lifo/node-compat/filesystem.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { processBridge } from './lib/process-bridge.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

/** What an error says, as a script would read it. */
const shape = (error, root) => error && {
  code: error.code,
  errno: error.errno,
  syscall: error.syscall,
  path: error.path?.replace(root, ''),
  message: error.message.replaceAll(root, ''),
};
/** The error `call` throws (sync) or passes to its callback, as `shape` reads it. */
const thrown = (call, root) => { try { call(); return null; } catch (error) { return shape(error, root); } };
const passed = (call, root) => new Promise((resolve) => call((error) => resolve(shape(error, root))));

// One tree, on disk for Node and in the session's VFS for the shell's node.
const disk = mkdtempSync(join(tmpdir(), 'lifo-fs-errors-'));
realFs.mkdirSync(join(disk, 'dir'));
realFs.writeFileSync(join(disk, 'file'), 'x');
const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = rawVfs.as(CRED_KERNEL);
kernel.mkdir('t/dir', { recursive: true });
kernel.writeFile('t/file', 'x');
const ours = createFs(synchronousFilesystem({ process: processBridge(rawVfs, CRED_KERNEL) })(), '/t');

const CASES = [
  ['readFileSync of a missing file', (fs, at) => fs.readFileSync(at('missing'))],
  ['readFileSync of a directory', (fs, at) => fs.readFileSync(at('dir'))],
  ['statSync of a missing file', (fs, at) => fs.statSync(at('missing'))],
  ['readdirSync of a file', (fs, at) => fs.readdirSync(at('file'))],
  ['openSync of a missing file', (fs, at) => fs.openSync(at('missing'), 'r')],
  ['accessSync of a missing file', (fs, at) => fs.accessSync(at('missing'))],
  ['realpathSync of a missing file', (fs, at) => fs.realpathSync(at('missing'))],
  ['mkdirSync of an existing directory', (fs, at) => fs.mkdirSync(at('dir'))],
  ['rmdirSync of a missing directory', (fs, at) => fs.rmdirSync(at('missing'))],
  ['unlinkSync of a missing file', (fs, at) => fs.unlinkSync(at('missing'))],
  ['readSync of a closed descriptor', (fs) => fs.readSync(987654, Buffer.alloc(1))],
];
const failed = [];
try {
  for (const [label, call] of CASES) {
    const node = thrown(() => call(realFs, (name) => join(disk, name)), disk);
    const lifo = thrown(() => call(ours, (name) => `/t/${name}`), '/t');
    try {
      assert.deepEqual(lifo, node, label);
    } catch (error) {
      failed.push(`${label}\n  node: ${JSON.stringify(node)}\n  ours: ${JSON.stringify(lifo)}`);
    }
  }
  for (const [label, call] of [
    ['readFile of a missing file', (fs, at, cb) => fs.readFile(at('missing'), cb)],
    ['stat of a missing file', (fs, at, cb) => fs.stat(at('missing'), cb)],
  ]) {
    const node = await passed((cb) => call(realFs, (name) => join(disk, name), cb), disk);
    const lifo = await passed((cb) => call(ours, (name) => `/t/${name}`, cb), '/t');
    try {
      assert.deepEqual(lifo, node, label);
    } catch {
      failed.push(`${label} (callback)\n  node: ${JSON.stringify(node)}\n  ours: ${JSON.stringify(lifo)}`);
    }
  }
} finally {
  rmSync(disk, { recursive: true, force: true });
  harness.db.close();
}
assert.deepEqual(failed, [], `every error is Node's:\n${failed.join('\n')}`);
console.log(`lifo-node-fs-errors: ${CASES.length + 2} failing calls error as Node's do`);
