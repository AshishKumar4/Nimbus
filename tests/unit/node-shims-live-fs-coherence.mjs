#!/usr/bin/env bun
// A long-running Node facet must treat its spawn-time VFS state as a cache,
// never as authority for async I/O after another process mutates SQLite VFS.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/worker/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const enc = new TextEncoder();
const dec = new TextDecoder();
const dir = '/home/user/coherence';
const resident = `${dir}/resident.txt`;
const late = `${dir}/late.txt`;

vfs.mkdir(dir, { recursive: true });
vfs.writeFile(resident, enc.encode('v1'));

const supervisor = {
  readFile: async (path) => {
    const bytes = await bridge.readFile(path);
    return bytes ? dec.decode(bytes) : null;
  },
  writeFile: (path, content) => bridge.writeFile(path, content),
  stat: (path) => bridge.stat(path),
  lstat: (path) => bridge.stat(path, { followSymlinks: false }),
  readdir: (path) => bridge.readdir(path),
  exists: async (path) => (await bridge.stat(path)) !== null,
  mkdir: (path) => bridge.mkdir(path, { recursive: true }),
  fsReadRange: (path, offset, length) => bridge.readRange(path, offset, length),
  fsWriteRange: (path, offset, bytes) => bridge.writeRange(path, offset, bytes),
  fsTruncate: (path, size) => bridge.truncate(path, size),
};

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() +
    '\n;return { fs: __fsMod };',
);
const { fs } = factory(
  { 'home/user/coherence/resident.txt': 'v1' },
  {
    'home/user/coherence': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 },
    'home/user/coherence/resident.txt': { type: 'file', size: 2, mode: 0o644, uid: 1000, gid: 1000 },
  },
  {},
  {
    'home/user': ['coherence'],
    'home/user/coherence': ['resident.txt'],
  },
  supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user/coherence',
  [],
  {},
  '/home/user/coherence/server.mjs',
  '/home/user/coherence',
);
const fsp = fs.promises;

// A sibling process mutates the authoritative VFS after this facet spawned.
const current = 'v2-longer-content';
vfs.writeFile(resident, enc.encode(current));
vfs.writeFile(late, enc.encode('created-after-spawn'));

const observed = {
  readFile: await fsp.readFile(resident, 'utf8'),
  statSize: (await fsp.stat(resident)).size,
  names: await fsp.readdir(dir),
  late: await fsp.readFile(late, 'utf8'),
  syncLateAfterAsync: null,
  handle: null,
  ranged: null,
  stream: '',
};
try {
  observed.syncLateAfterAsync = fs.readFileSync(late, 'utf8');
} catch (error) {
  observed.syncLateAfterAsync = error.code;
}

{
  const handle = await fsp.open(resident, 'r');
  observed.handle = await handle.readFile('utf8');
  await handle.close();
}

{
  const handle = await fsp.open(resident, 'r');
  const buffer = new Uint8Array(current.length);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  observed.ranged = dec.decode(buffer.subarray(0, bytesRead));
  await handle.close();
}

{
  for await (const chunk of fs.createReadStream(resident, { encoding: 'utf8' })) {
    observed.stream += chunk;
  }
}

assert.deepEqual(observed, {
  readFile: current,
  statSize: current.length,
  names: ['late.txt', 'resident.txt'],
  late: 'created-after-spawn',
  syncLateAfterAsync: 'ENOENT',
  handle: current,
  ranged: current,
  stream: current,
});

// Pending sync mutations are newer than the supervisor until flushed. An
// async observation must preserve them by making them authoritative first.
fs.writeFileSync(resident, 'same-facet-open-pending');
{
  const handle = await fsp.open(resident, 'r');
  assert.equal(
    dec.decode(vfs.readFile(resident)),
    'same-facet-open-pending',
    'async open flushes pending sync content before observing authority metadata',
  );
  await handle.close();
}

fs.writeFileSync(resident, 'same-facet-pending');
assert.equal(await fsp.readFile(resident, 'utf8'), 'same-facet-pending');
assert.equal(dec.decode(vfs.readFile(resident)), 'same-facet-pending');

fs.mkdirSync(`${dir}/same-facet-dir`);
assert.deepEqual(
  await fsp.readdir(`${dir}/same-facet-dir`),
  [],
  'async readdir flushes the exact pending directory before listing it',
);
assert.deepEqual(
  await fsp.readdir(dir),
  ['late.txt', 'resident.txt', 'same-facet-dir'],
);
assert.equal(vfs.stat(`${dir}/same-facet-dir`)?.type, 'directory');

console.log('node-shims-live-fs-coherence: all assertions passed');
