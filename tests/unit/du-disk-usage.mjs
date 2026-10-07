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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { testBox } from './lib/test-box.mjs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const GNU_DU = ['gnudu', 'du'].find((bin) => /GNU coreutils/.test(spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout ?? ''));
assert.ok(GNU_DU, 'GNU du is required as the oracle (gnudu or du from GNU coreutils)');

const ENV = { ...process.env, LC_ALL: 'C' };
// A directory's own blocks depend on the filesystem; tmpfs gives none, as the VFS does.
const disk = mkdtempSync(join(existsSync('/dev/shm') ? '/dev/shm' : tmpdir(), 'nimbus-du-'));
process.on('exit', () => rmSync(disk, { recursive: true, force: true }));

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('tmp/w', { recursive: true, mode: 0o777 });
const box = await testBox({ harness, vfs: rawVfs });

/** The same tree on disk and in the VFS. */
const tree = { 'big.bin': 2 * 1024 * 1024, 'd/g': 4096, 'd/sub/f': 8192, 'd/sub/deep/h': 4096, 'e/': 0 };
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
  const expected = spawnSync(GNU_DU, args, { cwd: disk, env: ENV, encoding: 'utf8' });
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
  // GNU's other options: depth, units, apparent sizes, links, separators, thresholds, exclusions.
  await same(['-h', '-d', '1', 'd'], { sorted: true });
  await same(['--max-depth=1', 'd'], { sorted: true });
  await same(['-d0', 'd']);
  await same(['-d', '1', '-a', 'd'], { sorted: true });
  await same(['-sm', 'big.bin', 'd']);
  await same(['-sb', 'd']);
  await same(['-b', 'd'], { sorted: true });
  await same(['--apparent-size', '-s', 'd']);
  // Apparent sizes are exact bytes; a 100-byte file's blocks differ by filesystem (tmpfs: a 4 KiB page), so only these look at it.
  writeFileSync(join(disk, 'small'), new Uint8Array(100));
  root.writeFile('tmp/w/small', new Uint8Array(100));
  await same(['--apparent-size', '-h', 'small']);
  await same(['-b', 'small', 'big.bin']);
  rmSync(join(disk, 'small'));
  root.unlink('tmp/w/small');
  // -h and --si round up as gnulib's human_readable does, carries included:
  // 1 MiB and a byte is 1.1M, not 1.0M.
  for (const size of [1023, 1025, 10239, 10241, 1048575, 1048577, 999999, 1000001]) {
    writeFileSync(join(disk, 'odd'), new Uint8Array(size));
    root.writeFile('tmp/w/odd', new Uint8Array(size));
    await same(['--apparent-size', '-h', 'odd']);
    await same(['--apparent-size', '--si', 'odd']);
  }
  rmSync(join(disk, 'odd'));
  root.unlink('tmp/w/odd');
  // -B and -t read GNU's suffixes: lower-case g is a GiB for -B; -t reads 0x hex.
  await same(['-s', '-B', 'k', 'd']);
  await same(['-s', '-B', 'KiB', 'd']);
  await same(['-s', '-B', '1g', 'big.bin']);
  await same(['-s', '-B', 'kB', 'd']);
  await same(['-t', '0x3000', 'd'], { sorted: true });
  await same(['-t', '9kB', 'd'], { sorted: true });
  await same(['-sL', '.']);
  await same(['-aL', 'lnk']);
  await same(['-sH', 'lnk']);
  await same(['-sP', '.']);
  await same(['-S', 'd'], { sorted: true });
  await same(['-0', '-s', 'd']);
  await same(['-s', '--si', 'big.bin']);
  await same(['-B', '1K', '-s', 'd']);
  await same(['-B', 'M', '-s', 'big.bin']);
  await same(['-sB1', 'd']);
  await same(['-sBKB', 'd']);
  await same(['--block-size=M', '-s', 'd']);
  await same(['-t', '5K', 'd'], { sorted: true });
  await same(['--exclude=deep', 'd'], { sorted: true });
  // --exclude's patterns are fnmatch's: a `[` with no `]` is a literal
  // (it used to compile to a RegExp and throw), classes and `?` match one.
  await same(['--exclude=d[', 'd'], { sorted: true });
  await same(['--exclude=[gh]', '-a', 'd'], { sorted: true });
  await same(['--exclude=su?', 'd'], { sorted: true });
  await same(['--exclude=*e*', '-a', 'd'], { sorted: true });
  await same(['--exclude=d/sub', '-a', 'd'], { sorted: true });
  await same(['-l', '-x', '-s', 'd']);
  // A link back to its own directory: -L walks into it once, and a directory
  // already on the path (same dev, ino) is skipped, unlisted, not an error.
  symlinkSync('.', join(disk, 'd/sub/loop'));
  root.symlink('.', 'tmp/w/d/sub/loop');
  await same(['-sL', 'd/sub/loop']);
  await same(['-L', 'd'], { sorted: true });
  await same(['-aL', 'd'], { sorted: true });
  await same(['-s', 'd/sub/loop']);
  await same(['d/sub/loop/deep']);
  rmSync(join(disk, 'd/sub/loop'));
  root.unlink('tmp/w/d/sub/loop');
  await same(['-d', 'x', 'd']);
  await same(['-d', '1', '-s', 'd']);
  await same(['-d', '0', '-s', 'd']);
  await same(['-B', '0', 'd']);
  await same(['-B', 'xx', 'd']);
  // A directory du cannot read is reported, summed as empty, and du goes on (exit 1).
  mkdirSync(join(disk, 'q/locked'), { recursive: true });
  writeFileSync(join(disk, 'q/locked/x'), new Uint8Array(4096));
  writeFileSync(join(disk, 'q/y'), new Uint8Array(8192));
  chmodSync(join(disk, 'q/locked'), 0);
  root.mkdir('tmp/w/q/locked', { recursive: true });
  root.writeFile('tmp/w/q/locked/x', new Uint8Array(4096));
  root.writeFile('tmp/w/q/y', new Uint8Array(8192));
  root.chmod('tmp/w/q/locked', 0);
  await same(['-s', 'q']);
  await same(['-a', 'q'], { sorted: true });
  chmodSync(join(disk, 'q/locked'), 0o755);
  console.log(`du-disk-usage: ${checks} invocations match GNU du`);
} finally {
  box.destroy();
}
