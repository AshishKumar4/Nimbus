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
  access: (path, mode) => bridge.access(path, mode),
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
let syncLateError = null;
try {
  observed.syncLateAfterAsync = fs.readFileSync(late, 'utf8');
} catch (error) {
  observed.syncLateAfterAsync = error.code;
  syncLateError = error;
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
  // NOT 'ENOENT'. The async readdir above enumerated late.txt and the async
  // read returned its bytes, so this process knows the file exists. A sync
  // read still cannot fetch content — a facet has no way to block on the
  // supervisor — but answering "no such file" would send the caller looking
  // for a file that is right there. EAGAIN is the same answer the fd path
  // (readSync/writeSync) has always given for a non-resident file.
  syncLateAfterAsync: 'EAGAIN',
  handle: current,
  ranged: current,
  stream: current,
});

// The refusal has to be actionable on its own: name the file, say why it
// could not be served, and name the call that will serve it.
assert.match(syncLateError.message, /late\.txt/);
assert.match(syncLateError.message, /not resident/);
assert.match(syncLateError.message, /fs\.promises\.readFile/);
assert.equal(syncLateError.path, late);
assert.equal(syncLateError.syscall, 'open');

// existsSync and readFileSync must agree about the same path. Reporting the
// file as present while the read reports it as absent is incoherent whatever
// else is true.
assert.equal(fs.existsSync(late), true);

// A path nothing has ever observed is still a plain ENOENT — the distinction
// only means something if genuine absence keeps its own code.
const absent = `${dir}/never-existed.txt`;
assert.equal(fs.existsSync(absent), false);
assert.throws(() => fs.readFileSync(absent, 'utf8'), (error) => {
  assert.equal(error.code, 'ENOENT');
  return true;
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

const accessCreated = `${dir}/access-created.txt`;
fs.writeFileSync(accessCreated, 'created-before-access');
await fsp.access(accessCreated);
assert.equal(dec.decode(vfs.readFile(accessCreated)), 'created-before-access');

fs.mkdirSync(`${dir}/same-facet-dir`);
assert.deepEqual(
  await fsp.readdir(`${dir}/same-facet-dir`),
  [],
  'async readdir flushes the exact pending directory before listing it',
);
assert.deepEqual(
  await fsp.readdir(dir),
  ['access-created.txt', 'late.txt', 'resident.txt', 'same-facet-dir'],
);
assert.equal(vfs.stat(`${dir}/same-facet-dir`)?.type, 'directory');

// Removal has to retract the path from the sync existence view too. The
// spawn-time metadata snapshot outlives the file it describes, so without
// that retraction a deleted file keeps reporting as present — and the read
// path would call it merely non-resident instead of gone.
assert.equal(fs.existsSync(resident), true);
fs.unlinkSync(resident);
assert.equal(fs.existsSync(resident), false);
assert.throws(() => fs.readFileSync(resident, 'utf8'), (error) => {
  assert.equal(error.code, 'ENOENT');
  return true;
});

// A directory is not "non-resident content" — reading one is EISDIR, the
// answer Node gives, not a suggestion to retry the read asynchronously.
assert.throws(() => fs.readFileSync(dir, 'utf8'), (error) => {
  assert.equal(error.code, 'EISDIR');
  return true;
});

console.log('node-shims-live-fs-coherence: all assertions passed');
