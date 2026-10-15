#!/usr/bin/env bun
// @tier slow — boots real CPython off local disk.
// A small read-only file a WASI program opens is read from the bytes the
// codec keeps of it (a resident descriptor), and its offset is the
// descriptor's as it is on Linux: a seek past the end stays there, a read
// at the end reads nothing and moves nothing, and pread never moves it.
// Checked against the host's python3 running the same program.
//
// Red before: a read at or past the end set the offset to the file's
// size, so a seek to 100 then a read reported 3 (lseek(fd, 0, SEEK_CUR)).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';
import { missingRuntimeFile, RUNTIMES, seedRuntime } from './lib/wasm-runtimes.mjs';

const missing = missingRuntimeFile();
if (missing !== null) {
  console.log(`wasi-resident-offset: SKIPPED (${missing} not built)`);
  process.exit(0);
}

const PROGRAM = [
  'import os',
  "f = os.open('f.txt', os.O_RDONLY)",
  'print(os.lseek(f, 100, os.SEEK_SET))',
  'print(os.read(f, 1))',
  'print(os.lseek(f, 0, os.SEEK_CUR))',
  'print(os.read(f, 0), os.lseek(f, 0, os.SEEK_CUR))',
  'os.lseek(f, 3, os.SEEK_SET)',
  'print(os.read(f, 1), os.lseek(f, 0, os.SEEK_CUR))',
  'os.lseek(f, 1, os.SEEK_SET)',
  'print(os.pread(f, 2, 100), os.lseek(f, 0, os.SEEK_CUR))',
  'print(os.pread(f, 2, 1), os.lseek(f, 0, os.SEEK_CUR))',
  'print(os.read(f, 5), os.lseek(f, 0, os.SEEK_CUR))',
].join('\n');

const dir = mkdtempSync(join(tmpdir(), 'wasi-resident-offset-'));
let host;
try {
  writeFileSync(join(dir, 'f.txt'), 'abc');
  host = spawnSync('python3', ['-c', PROGRAM], { cwd: dir, encoding: 'utf8' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
assert.equal(host.status, 0, `host python3: ${host.stderr}`);

const { sql, transactions } = await hostSqlite();
const open = (options) => NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user', ...options });
const seeded = await open({});
seedRuntime(seeded.vfs, RUNTIMES.find((r) => r.name === 'cpython'));
const ws = await open({ facets: localFacetHost(ISOLATE_NETWORK) });
try {
  ws.vfs.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }).writeFile('home/user/f.txt', 'abc');
  const ours = await ws.exec(`python3 -c ${JSON.stringify(PROGRAM)}`);
  assert.deepEqual({ stdout: ours.stdout, exitCode: ours.exitCode }, { stdout: host.stdout, exitCode: 0 }, `as host python3 (stderr: ${ours.stderr.slice(-400)})`);
  console.log('  ✓ a seek past the end, a read at the end and pread leave the offset where Linux does');
} finally {
  await ws.close();
  await seeded.close();
}
console.log('wasi-resident-offset: ok');
