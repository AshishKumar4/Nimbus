#!/usr/bin/env bun
// cksum -a crc32b prints what GNU cksum prints, for files of every size a
// read splits differently (empty, one byte, a chunk and a bit, several
// chunks) and for standard input.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const bytes = (length, seed) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed * 7 + (i >> 9)) & 0xff);
const FILES = { empty: bytes(0, 0), one: bytes(1, 1), chunkAndABit: bytes(65_536 + 3, 2), several: bytes(300_001, 3) };
const names = Object.keys(FILES).join(' ');

const dir = mkdtempSync(join(tmpdir(), 'cksum-crc32b-'));
let gnu;
try {
  for (const [name, data] of Object.entries(FILES)) writeFileSync(join(dir, name), data);
  const files = spawnSync('sh', ['-c', `cksum -a crc32b ${names}; cksum -a crc32b < several`], { cwd: dir, encoding: 'utf8' });
  assert.equal(files.status, 0, `GNU cksum: ${files.stderr}`);
  gnu = files.stdout;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
try {
  for (const [name, data] of Object.entries(FILES)) await ws.fs.writeFile(`/home/user/${name}`, data);
  const ours = await ws.exec(`cksum -a crc32b ${names}; cksum -a crc32b < several`, { cwd: '/home/user' });
  assert.equal(ours.exitCode, 0, ours.stderr);
  assert.equal(ours.stdout, gnu, 'the same CRC and size as GNU cksum for each file and for stdin');
  console.log('  ✓ cksum -a crc32b matches GNU cksum for every size and for stdin');
} finally {
  await ws.close();
}
console.log('cksum-crc32b-gnu: ok');
