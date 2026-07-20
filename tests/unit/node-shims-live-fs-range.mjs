#!/usr/bin/env bun
// Behavior tests for the generated Node dynamic-Worker fs shims against the
// REAL SqliteRuntimeFsBridge: FileHandle positional read/write/truncate,
// fs.promises.truncate, and appendFile must use the stateless range RPCs
// (fsReadRange/fsWriteRange/fsTruncate) instead of whole-file rewrites, and
// live VFS content stays authoritative.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts';
import { getSymlinkRegistry } from '../../packages/worker/src/vfs/symlink-registry.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const bridge = new SqliteRuntimeFsBridge(vfs);

// Supervisor stub speaking the SupervisorRPC fs surface over the real bridge.
const supervisor = {
  readFile: async (p) => { const b = await bridge.readFile(p); return b ? new TextDecoder().decode(b) : null; },
  readFileBytes: (p) => bridge.readFile(p),
  writeFile: (p, c) => bridge.writeFile(p, c),
  stat: (p) => bridge.stat(p),
  lstat: (p) => bridge.stat(p, { followSymlinks: false }),
  readdir: (p) => bridge.readdir(p),
  exists: async (p) => (await bridge.stat(p)) !== null,
  mkdir: (p) => bridge.mkdir(p, { recursive: true }),
  unlink: (p) => bridge.unlink(p),
  rmdir: (p) => bridge.rmdir(p),
  rename: (f, t) => bridge.rename(f, t),
  readlink: (p) => bridge.readlink(p),
  symlink: (t, p) => bridge.symlink(t, p),
  utimes: (p, a, m) => bridge.utimes(p, a, m),
  fsReadRange: (p, o, l) => bridge.readRange(p, o, l),
  fsWriteRange: (p, o, b) => bridge.writeRange(p, o, b),
  fsTruncate: (p, s) => bridge.truncate(p, s),
};

const code = generateShimsCode();
const factory = new Function(
  '__vfsBundle', '__vfsWrites', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + code + '\n;return { fs: __fsMod };'
);
const sandbox = factory({}, {}, {}, null, supervisor, '/home/user', [], {}, '/home/user/main.mjs', '/home/user');
const fsp = sandbox.fs.promises;
const enc = new TextEncoder();

// Seed a live-only file (outside the bundle).
vfs.mkdir('home/user', { recursive: true });
vfs.writeFile('home/user/live.bin', enc.encode('0123456789abcdef'));

await bridge.symlink('live.bin', '/home/user/live-link');
assert.equal((await fsp.stat('/home/user/live-link')).isFile(), true);
const liveLink = await fsp.lstat('/home/user/live-link');
assert.equal(liveLink.isSymbolicLink(), true);
assert.equal(liveLink.mode, 0o120777);
await assert.rejects(bridge.symlink('live.bin', '/home/user/live.bin'), /EEXIST/);
assert.equal(new TextDecoder().decode(vfs.readFile('home/user/live.bin')), '0123456789abcdef');

vfs.mkdir('home/user/legacy-over-directory');
getSymlinkRegistry(vfs).set('home/user/legacy-over-directory', 'live.bin');
const legacyLstat = await bridge.stat('/home/user/legacy-over-directory', { followSymlinks: false });
assert.equal(legacyLstat.type, 'directory');

// open 'r' + positional FileHandle.read over live ranges
{
  const fh = await fsp.open('/home/user/live.bin', 'r');
  const buf = new Uint8Array(4);
  const r = await fh.read(buf, 0, 4, 6);
  assert.equal(r.bytesRead, 4);
  assert.equal(new TextDecoder().decode(buf), '6789');
  const seq = await fh.read(new Uint8Array(3), 0, 3); // sequential from position 0
  assert.equal(seq.bytesRead, 3);
  assert.equal(new TextDecoder().decode(seq.buffer), '012');
  await fh.close();
  await assert.rejects(fh.read(new Uint8Array(1), 0, 1), /EBADF/);
}

// open 'r' on a missing file throws ENOENT
await assert.rejects(fsp.open('/home/user/nope.bin', 'r'), /ENOENT/);

// open 'r+' positional write rewrites only the touched range live
{
  const fh = await fsp.open('/home/user/live.bin', 'r+');
  const w = await fh.write(enc.encode('XY'), 0, 2, 3);
  assert.equal(w.bytesWritten, 2);
  await fh.close();
  assert.equal(new TextDecoder().decode(vfs.readFile('home/user/live.bin')), '012XY56789abcdef');
}

// open 'w' truncates; writes land live; size tracked
{
  const fh = await fsp.open('/home/user/live.bin', 'w');
  await fh.write(enc.encode('fresh'));
  await fh.write(enc.encode('!'), 0, 1, 5);
  await fh.close();
  assert.equal(new TextDecoder().decode(vfs.readFile('home/user/live.bin')), 'fresh!');
}

// open 'a' appends at live EOF
{
  const fh = await fsp.open('/home/user/live.bin', 'a');
  await fh.write(enc.encode('+more'));
  await fh.close();
  assert.equal(new TextDecoder().decode(vfs.readFile('home/user/live.bin')), 'fresh!+more');
}

// FileHandle.truncate + fs.promises.truncate hit the live boundary chunk
{
  const fh = await fsp.open('/home/user/live.bin', 'r+');
  await fh.truncate(5);
  await fh.close();
  assert.equal(new TextDecoder().decode(vfs.readFile('home/user/live.bin')), 'fresh');
  await fsp.truncate('/home/user/live.bin', 2);
  assert.equal(new TextDecoder().decode(vfs.readFile('home/user/live.bin')), 'fr');
  await assert.rejects(fsp.truncate('/home/user/never.bin', 1), /ENOENT/);
}

// appendFile on a live-only file appends instead of clobbering
{
  vfs.writeFile('home/user/log.txt', enc.encode('line1\n'));
  await fsp.appendFile('/home/user/log.txt', 'line2\n');
  assert.equal(new TextDecoder().decode(vfs.readFile('home/user/log.txt')), 'line1\nline2\n');
  // and async reads see the merged live content
  assert.equal(await fsp.readFile('/home/user/log.txt', 'utf8'), 'line1\nline2\n');
}

// writeFile + appendFile flow (probe parity: WRITE=ok path)
{
  await fsp.writeFile('/home/user/out.txt', 'live-write-ok\n');
  await fsp.appendFile('/home/user/out.txt', 'append-ok\n');
  assert.equal(new TextDecoder().decode(vfs.readFile('home/user/out.txt')), 'live-write-ok\nappend-ok\n');
}

// exclusive create
await assert.rejects(fsp.open('/home/user/out.txt', 'wx'), /EEXIST/);

// open with create on missing file creates it live
{
  const fh = await fsp.open('/home/user/made.txt', 'w');
  await fh.writeFile('content');
  await fh.close();
  assert.equal(new TextDecoder().decode(vfs.readFile('home/user/made.txt')), 'content');
}

// Range writes through a FileHandle must not rewrite untouched chunks.
{
  const CHUNK = 65536;
  const big = new Uint8Array(CHUNK * 2).fill(7);
  vfs.writeFile('home/user/huge.bin', big);
  const statementStart = harness.statementCount;
  const fh = await fsp.open('/home/user/huge.bin', 'r+');
  await fh.write(enc.encode('!!'), 0, 2, CHUNK + 1); // inside chunk 1 only
  await fh.close();
  const chunkWrites = harness.statements.slice(statementStart)
    .filter((statement) => /INSERT OR REPLACE INTO file_chunks/i.test(statement.sql))
    .reduce((count, statement) => count + (statement.params.length / 3), 0);
  assert.equal(chunkWrites, 1, 'a small FileHandle positional write must rewrite one chunk');
}

console.log('node-shims-live-fs-range: all assertions passed');
