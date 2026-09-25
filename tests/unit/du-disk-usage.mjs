#!/usr/bin/env bun
// du reports disk usage the way GNU du does: by the blocks each file holds,
// for each operand as it was named, with -a, -s, -c, -h and -k, and GNU's
// errors. `du -h big.bin` for a 2 MiB file used to print `0B` (a file
// operand was read as a directory) under its absolute path.
//
// The oracle is GNU du (coreutils 9.7, `gnudu` here) over the same tree on a
// tmpfs. A file there holds whole 4 KiB pages and a directory none, and the
// VFS's blocks (stat %b: ceil(size / 512) 512-byte units, a directory 0, a
// link 0) agree with that for files whose sizes are multiples of 4 KiB, so
// every file below is one. Lines are compared sorted where a directory has
// more than one entry: listing order is the filesystem's, not du's.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/core/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const GNU_DU = ['gnudu', 'du'].find((bin) => /GNU coreutils/.test(spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout ?? ''));
assert.ok(GNU_DU, 'GNU du is required as the oracle (gnudu or du from GNU coreutils)');

const disk = mkdtempSync(join(tmpdir(), 'nimbus-du-'));
process.on('exit', () => rmSync(disk, { recursive: true, force: true }));

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('tmp/w', { recursive: true, mode: 0o777 });
const box = await Sandbox.create({ persist: false });
box.kernel.vfs.mount('/tmp', new SqliteVFSProvider(rawVfs, 'tmp'));
registerUnixCommands(box.commands.registry, rawVfs);

/** The same tree on disk and in the VFS. */
const tree = { 'big.bin': 2 * 1024 * 1024, 'd/g': 4096, 'd/sub/f': 8192, 'e/': 0 };
for (const [path, size] of Object.entries(tree)) {
  if (path.endsWith('/')) {
    mkdirSync(join(disk, path), { recursive: true });
    root.mkdir(`tmp/w/${path.slice(0, -1)}`, { recursive: true });
    continue;
  }
  mkdirSync(join(disk, path, '..'), { recursive: true });
  writeFileSync(join(disk, path), new Uint8Array(size));
  root.mkdir(`tmp/w/${path}`.split('/').slice(0, -1).join('/'), { recursive: true });
  root.writeFile(`tmp/w/${path}`, new Uint8Array(size));
}
symlinkSync('big.bin', join(disk, 'lnk'));
root.symlink('big.bin', 'tmp/w/lnk');

let checks = 0;
async function same(args, { sorted = false } = {}) {
  const expected = spawnSync(GNU_DU, args, { cwd: disk, encoding: 'utf8' });
  const actual = await box.shell.execute(`cd /tmp/w && du ${args.map((a) => `'${a}'`).join(' ')}`, {});
  const order = (text) => (sorted ? text.split('\n').filter(Boolean).sort().join('\n') : text);
  const label = `du ${args.join(' ')}`;
  assert.equal(actual.exitCode, expected.status, `${label}: exit (stderr ${JSON.stringify(actual.stderr)})`);
  assert.equal(order(actual.stdout), order(expected.stdout), `${label}: stdout`);
  assert.equal(actual.stderr, expected.stderr.replaceAll(GNU_DU, 'du'), `${label}: stderr`);
  checks++;
}

try {
  await same(['-h', 'big.bin']);
  await same(['big.bin']);
  await same(['-k', 'big.bin']);
  await same(['d']);
  await same(['d/']);
  await same(['-a', 'd'], { sorted: true });
  await same(['-ah', 'd'], { sorted: true });
  await same(['-s', 'd']);
  await same(['-sh', 'd/']);
  await same(['-h', 'd', 'e']);
  await same(['-c', '-s', 'd', 'big.bin']);
  await same(['-ch', 'big.bin', 'd']);
  await same(['--summarize', '--human-readable', '--total', 'big.bin', 'd']);
  await same(['lnk']);
  await same(['-sh']);
  await same(['-s', '.']);
  await same(['nope']);
  await same(['-s', 'nope', 'd']);
  await same(['-Q', 'd']);
  await same(['--bogus', 'd']);
  await same(['-as', 'd']);
  console.log(`du-disk-usage: ${checks} invocations match GNU du`);
} finally {
  box.destroy();
}
