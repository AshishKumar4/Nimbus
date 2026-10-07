#!/usr/bin/env bun
/**
 * The errors the shell's built-in node (lifo node-compat/fs.ts) throws for
 * a filesystem call that fails are Node's: the same code, errno, syscall,
 * path and message as real Node's fs gives for the same call on the same
 * tree, sync and callback alike (one error shape, core vfs/vfs-error.ts).
 * The oracle is the `node` on PATH (the CI image's Node 22), in a process
 * of its own: this test runs under Bun, whose node:fs is not Node's.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
/**
 * The error `call` throws (sync) or passes to its callback, as `shape` reads
 * it, through JSON as the oracle's comes (a field it lacks is absent).
 */
const json = (value) => JSON.parse(JSON.stringify(value));
const thrown = (call, root) => { try { call(); return null; } catch (error) { return json(shape(error, root)); } };
const passed = (call, root) => new Promise((resolve) => call((error) => resolve(json(shape(error, root)))));

/** Each case's code, run against `fs` with `at(name)` naming a file of the tree (and `cb`, a callback case's). */
const SYNC = {
  'readFileSync of a missing file': 'fs.readFileSync(at("missing"))',
  'readFileSync of a directory': 'fs.readFileSync(at("dir"))',
  'statSync of a missing file': 'fs.statSync(at("missing"))',
  'readdirSync of a file': 'fs.readdirSync(at("file"))',
  'openSync of a missing file': 'fs.openSync(at("missing"), "r")',
  'accessSync of a missing file': 'fs.accessSync(at("missing"))',
  'realpathSync of a missing file': 'fs.realpathSync(at("missing"))',
  'mkdirSync of an existing directory': 'fs.mkdirSync(at("dir"))',
  'rmdirSync of a missing directory': 'fs.rmdirSync(at("missing"))',
  'unlinkSync of a missing file': 'fs.unlinkSync(at("missing"))',
  'readSync of a closed descriptor': 'fs.readSync(987654, Buffer.alloc(1))',
};
const CALLBACK = {
  'readFile of a missing file': 'fs.readFile(at("missing"), cb)',
  'stat of a missing file': 'fs.stat(at("missing"), cb)',
};

// One tree, on disk for Node and in the session's VFS for the shell's node.
const disk = mkdtempSync(join(tmpdir(), 'lifo-fs-errors-'));
mkdirSync(join(disk, 'dir'));
writeFileSync(join(disk, 'file'), 'x');
const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = rawVfs.as(CRED_KERNEL);
kernel.mkdir('t/dir', { recursive: true });
kernel.writeFile('t/file', 'x');
const ours = createFs(synchronousFilesystem({ process: processBridge(rawVfs, CRED_KERNEL) })(), '/t');

// Real Node, on the disk tree: every case's error, as `shape` reads it.
const oracle = spawnSync('node', ['--input-type=module', '-e', `
  import * as fs from 'node:fs';
  const root = ${JSON.stringify(disk)};
  const at = (name) => root + '/' + name;
  const shape = ${shape.toString()};
  const out = { runtime: typeof Bun === 'undefined' ? 'node ' + process.versions.node : 'bun', sync: {}, callback: {} };
  for (const [label, code] of Object.entries(${JSON.stringify(SYNC)})) {
    try { new Function('fs', 'at', code)(fs, at); out.sync[label] = null; } catch (error) { out.sync[label] = shape(error, root); }
  }
  for (const [label, code] of Object.entries(${JSON.stringify(CALLBACK)})) {
    out.callback[label] = await new Promise((resolve) => new Function('fs', 'at', 'cb', code)(fs, at, (error) => resolve(shape(error, root))));
  }
  process.stdout.write(JSON.stringify(out));
`], { encoding: 'utf8' });
assert.equal(oracle.status, 0, oracle.stderr);
const node = JSON.parse(oracle.stdout);
assert.match(node.runtime, /^node \d+\./, `the oracle is Node: ${node.runtime}`);

const failed = [];
try {
  for (const [label, code] of Object.entries(SYNC)) {
    const lifo = thrown(() => new Function('fs', 'at', code)(ours, (name) => `/t/${name}`), '/t');
    try {
      assert.deepEqual(lifo, node.sync[label], label);
    } catch {
      failed.push(`${label}\n  node: ${JSON.stringify(node.sync[label])}\n  ours: ${JSON.stringify(lifo)}`);
    }
  }
  for (const [label, code] of Object.entries(CALLBACK)) {
    const lifo = await passed((cb) => new Function('fs', 'at', 'cb', code)(ours, (name) => `/t/${name}`, cb), '/t');
    try {
      assert.deepEqual(lifo, node.callback[label], label);
    } catch {
      failed.push(`${label} (callback)\n  node: ${JSON.stringify(node.callback[label])}\n  ours: ${JSON.stringify(lifo)}`);
    }
  }
} finally {
  rmSync(disk, { recursive: true, force: true });
  harness.db.close();
}
assert.deepEqual(failed, [], `every error is Node's:\n${failed.join('\n')}`);
console.log(`lifo-node-fs-errors: ${Object.keys(SYNC).length + Object.keys(CALLBACK).length} failing calls error as ${node.runtime}'s do`);
