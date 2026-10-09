#!/usr/bin/env bun
// Unit tests for SqliteRuntimeFsBridge range ops (readRange/writeRange/
// truncate), per-path revision semantics (stat().revision, revision(path),
// expectedRevision, handle ESTALE isolation), and symlink resolution
// through durable SqliteVFS symlink inodes.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import {
  CHUNK_SIZE,
  MAX_TX_BLOB_BYTES,
  MAX_TX_LOGICAL_ROWS,
  SQL_MAX_BOUND_PARAMETERS,
} from '../../packages/platform/src/limits.ts';
import { getSymlinkRegistry } from '../../packages/core/src/vfs/symlink-registry.ts';
import { chunkBytesWritten, createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';


// The directories the cases write into: a write never creates its parent.
const FIXTURE_DIRS = ['home/user', 'a', 'b', 'wk', 'x', 'y', 'real/dir', 'links', 'loop', 'append', 'targets'];
function makeBridge() {
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  for (const dir of FIXTURE_DIRS) rawVfs.as(CRED_KERNEL).mkdir(dir, { recursive: true });
  return {
    harness,
    rawVfs,
    vfs: rawVfs.as(CRED_KERNEL),
    bridge: new SqliteRuntimeFsBridge(rawVfs.as(CRED_KERNEL), rawVfs),
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const CRED_OTHER = Object.freeze({
  uid: 2001,
  gid: 2001,
  groups: Object.freeze([2001]),
  umask: 0o022,
});

// ── readRange / writeRange / truncate basics ──
{
  const { bridge } = makeBridge();
  await bridge.writeFile('/home/user/data.txt', 'hello world');

  assert.equal(dec.decode(await bridge.readRange('/home/user/data.txt', 6, 5)), 'world');
  assert.equal((await bridge.readRange('/home/user/data.txt', 100, 5)).length, 0, 'past EOF clamps to empty');
  assert.equal(await bridge.readRange('/home/user/missing.txt', 0, 5), null, 'missing file reads as null');

  const receipt = await bridge.writeRange('/home/user/data.txt', 6, enc.encode('WORLD'));
  assert.ok(receipt.after > receipt.before, 'writeRange answers with the revisions around it');
  assert.equal(dec.decode(await bridge.readFile('/home/user/data.txt')), 'hello WORLD');

  // A missing parent is ENOENT, as open(O_CREAT); createParents is mkdir -p.
  await assert.rejects(async () => bridge.writeRange('/home/user/new/dir/file.bin', 2, enc.encode('xy')), { code: 'ENOENT' });
  await assert.rejects(async () => bridge.writeFile('/home/user/new/dir/file.bin', 'xy'), { code: 'ENOENT' });
  await bridge.writeRange('/home/user/new/dir/file.bin', 2, enc.encode('xy'), { createParents: true });
  const created = await bridge.readFile('/home/user/new/dir/file.bin');
  assert.deepEqual(Array.from(created), [0, 0, 120, 121]);
  assert.equal((await bridge.stat('/home/user/new/dir')).type, 'directory');

  await bridge.truncate('/home/user/data.txt', 5);
  assert.equal(dec.decode(await bridge.readFile('/home/user/data.txt')), 'hello');
  await assert.rejects(async () => bridge.truncate('/home/user/missing.txt', 0), /ENOENT/);
  await bridge.mkdir('/home/user/adir');
  await assert.rejects(async () => bridge.truncate('/home/user/adir', 0), /EISDIR/);
  await assert.rejects(async () => bridge.writeRange('/home/user/adir', 0, enc.encode('x')), /EISDIR/);
}

// ── read misses are null; permission and type errors stay errors ──
{
  const { rawVfs, vfs } = makeBridge();
  vfs.mkdir('/private', { mode: 0o700 });
  vfs.writeFile('/private/hidden.txt', 'hidden');
  vfs.mkdir('/visible', { mode: 0o711 });
  vfs.writeFile('/visible/denied.txt', 'denied', { mode: 0o000 });
  vfs.mkdir('/visible/directory', { mode: 0o755 });

  const denied = new SqliteRuntimeFsBridge(rawVfs.as(CRED_OTHER), rawVfs);
  await assert.rejects(
    async () => denied.stat('/private/hidden.txt'),
    (error) => error.code === 'EACCES',
  );
  await assert.rejects(
    async () => denied.readFile('/visible/denied.txt'),
    (error) => error.code === 'EACCES',
  );
  await assert.rejects(
    async () => denied.readRange('/visible/denied.txt', 0, 1),
    (error) => error.code === 'EACCES',
  );
  await assert.rejects(
    async () => denied.readRange('/visible/directory', 0, 1),
    (error) => error.code === 'EISDIR',
  );
  assert.equal(await denied.stat('/visible/missing.txt'), null);
  assert.equal(await denied.readFile('/visible/missing.txt'), null);
  assert.equal(await denied.readRange('/visible/missing.txt', 0, 1), null);
}

// ── per-path revisions: stat().revision + revision(path) isolation ──
{
  const { bridge } = makeBridge();
  await bridge.writeFile('/a/one.txt', '1');
  await bridge.writeFile('/b/two.txt', '2');

  const aRev = (await bridge.stat('/a/one.txt')).revision;
  assert.equal(aRev, await bridge.revision('/a/one.txt'));

  await bridge.writeFile('/b/two.txt', '22');
  assert.equal((await bridge.stat('/a/one.txt')).revision, aRev,
    'mutating /b must not move /a revisions');
  assert.ok((await bridge.stat('/b/two.txt')).revision > aRev);
  assert.ok((await bridge.revision()) >= (await bridge.revision('/b')), 'global watermark covers all subtrees');

  // expectedRevision: per-path compare-and-set.
  const cur = await bridge.revision('/a/one.txt');
  await bridge.writeFile('/a/one.txt', 'fresh', { expectedRevision: cur });
  await assert.rejects(
    async () => bridge.writeFile('/a/one.txt', 'stale', { expectedRevision: cur }),
    /ESTALE/,
  );
  await assert.rejects(
    async () => bridge.writeRange('/a/one.txt', 0, enc.encode('s'), { expectedRevision: cur }),
    /ESTALE/,
  );
  // Mutations elsewhere do NOT invalidate a per-path expectedRevision.
  const aNow = await bridge.revision('/a/one.txt');
  await bridge.writeFile('/b/two.txt', 'unrelated');
  await bridge.writeRange('/a/one.txt', 0, enc.encode('F'), { expectedRevision: aNow });
  assert.equal(dec.decode(await bridge.readFile('/a/one.txt')), 'Fresh');
}

// ── handles: positional range IO without whole-file rewrites ──
{
  const { harness, bridge } = makeBridge();
  const big = new Uint8Array(CHUNK_SIZE * 2);
  big.fill(9);
  await bridge.writeFile('/wk/big.bin', big);
  const handle = await bridge.open('/wk/big.bin', { read: true, write: true });
  // Positional read.
  assert.deepEqual(Array.from(await bridge.read(handle.id, 5, 3)), [9, 9, 9]);
  // Sequential read advances the cursor.
  await bridge.read(handle.id, null, 4);
  assert.equal((await bridge.read(handle.id, null, 0)).length, 0);

  // Positional write inside chunk 1 must commit exactly one chunk.
  const statementStart = harness.statementCount;
  await bridge.write(handle.id, CHUNK_SIZE + 10, enc.encode('zz'));
  const chunkWrites = chunkBytesWritten(harness, statementStart);
  assert.ok(chunkWrites > 0 && chunkWrites <= CHUNK_SIZE, `a small positional write stored ${chunkWrites} chunk bytes, not the file`);
  const verify = await bridge.readRange('/wk/big.bin', CHUNK_SIZE + 9, 4);
  assert.deepEqual(Array.from(verify), [9, 122, 122, 9]);
  assert.equal((await bridge.stat('/wk/big.bin')).size, big.length, 'positional write must not grow the file');
  await bridge.close(handle.id);

  // Append-flag handle writes land at EOF.
  const app = await bridge.open('/wk/big.bin', { write: true, append: true });
  await bridge.write(app.id, null, enc.encode('tail'));
  assert.equal((await bridge.stat('/wk/big.bin')).size, big.length + 4);
  assert.equal(dec.decode(await bridge.readRange('/wk/big.bin', big.length, 4)), 'tail');
  await bridge.close(app.id);
}

// ── handles: ESTALE is per-path, not global ──
{
  const { bridge } = makeBridge();
  await bridge.writeFile('/x/file.txt', 'x');
  await bridge.writeFile('/y/file.txt', 'y');

  const handle = await bridge.open('/x/file.txt', { read: true, write: true });
  // Unrelated mutations must not stale this handle (the old global
  // revision check failed exactly this case).
  await bridge.writeFile('/y/file.txt', 'changed');
  await bridge.unlink('/y/file.txt');
  await bridge.write(handle.id, 0, enc.encode('X'));
  assert.equal(dec.decode(await bridge.readFile('/x/file.txt')), 'X');

  // A descriptor remains bound to its live inode after another writer updates it.
  await bridge.writeFile('/x/file.txt', 'external');
  await bridge.write(handle.id, 0, enc.encode('!'));
  assert.equal(dec.decode(await bridge.readFile('/x/file.txt')), '!xternal');
  await bridge.close(handle.id);

  // open with truncate resets content via the boundary-chunk path.
  const tr = await bridge.open('/x/file.txt', { write: true, truncate: true });
  assert.equal((await bridge.stat('/x/file.txt')).size, 0);
  await bridge.close(tr.id);
}

// ── symlinks: native inode durability, metadata, and resolution ──
{
  const { harness, vfs, bridge } = makeBridge();
  await bridge.writeFile('/real/target.txt', 'abcdefgh');
  await bridge.symlink('/real/target.txt', '/links/alias.txt');

  assert.equal(vfs.isSymlink('links/alias.txt'), true, 'new links must be native VFS inodes');
  assert.equal(vfs.readlink('links/alias.txt'), '/real/target.txt');
  assert.equal(await bridge.readlink('/links/alias.txt'), '/real/target.txt');
  const linkStat = await bridge.stat('/links/alias.txt', { followSymlinks: false });
  assert.equal(linkStat.type, 'symlink');
  assert.equal(linkStat.mode, 0o120777, 'lstat mode must include the symlink inode type');
  assert.equal(linkStat.size, enc.encode('/real/target.txt').byteLength);
  assert.equal((await bridge.stat('/links/alias.txt')).type, 'file');
  assert.deepEqual(
    await bridge.readdir('/links'),
    [{ name: 'alias.txt', type: 'symlink' }],
    'native symlinks must appear exactly once with their real directory-entry type',
  );
  assert.equal(dec.decode(await bridge.readRange('/links/alias.txt', 2, 3)), 'cde');
  await bridge.writeRange('/links/alias.txt', 0, enc.encode('AB'));
  assert.equal(dec.decode(await bridge.readFile('/real/target.txt')), 'ABcdefgh');
  await bridge.truncate('/links/alias.txt', 4);
  assert.equal(dec.decode(await bridge.readFile('/real/target.txt')), 'ABcd');
  // revision(link) follows the link target's data path.
  assert.equal(await bridge.revision('/links/alias.txt'), await bridge.revision('/real/target.txt'));

  const reloadedRawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const reloadedVfs = reloadedRawVfs.as(CRED_KERNEL);
  const reloadedBridge = new SqliteRuntimeFsBridge(reloadedVfs, reloadedRawVfs);
  assert.equal(reloadedVfs.isSymlink('links/alias.txt'), true, 'symlink kind must survive VFS reload');
  assert.equal(await reloadedBridge.readlink('/links/alias.txt'), '/real/target.txt');
  assert.equal(
    (await reloadedBridge.stat('/links/alias.txt', { followSymlinks: false })).mode,
    0o120777,
    'the symlink mode must survive VFS reload',
  );
  assert.equal(dec.decode(await reloadedBridge.readFile('/links/alias.txt')), 'ABcd');
  await reloadedBridge.rename('/links/alias.txt', '/links/renamed.txt');
  assert.equal(reloadedVfs.isSymlink('links/alias.txt'), false);
  assert.equal(reloadedVfs.isSymlink('links/renamed.txt'), true);
  assert.equal(await reloadedBridge.readlink('/links/renamed.txt'), '/real/target.txt');
  await reloadedBridge.unlink('/links/renamed.txt');
  assert.equal(reloadedVfs.exists('links/renamed.txt'), false);
}

// ── symlinks: intermediate components, loops, and legacy read fallback ──
{
  const { rawVfs, vfs, bridge } = makeBridge();
  await bridge.writeFile('/real/dir/file.txt', 'through-directory-link');
  await bridge.symlink('../real/dir', '/links/dir');
  assert.equal(
    dec.decode(await bridge.readFile('/links/dir/file.txt')),
    'through-directory-link',
    'resolution must follow symlinks in intermediate path components',
  );
  assert.deepEqual(await bridge.readdir('/links/dir'), [{ name: 'file.txt', type: 'file' }]);

  await bridge.symlink('../missing-target', '/links/dangling');
  assert.equal(await bridge.readlink('/links/dangling'), '../missing-target');
  assert.equal(await bridge.stat('/links/dangling'), null, 'stat follows a dangling symlink');
  assert.equal((await bridge.stat('/links/dangling', { followSymlinks: false })).type, 'symlink');

  await bridge.symlink('two', '/loop/one');
  await bridge.symlink('one', '/loop/two');
  await assert.rejects(async () => bridge.stat('/loop/one'), { code: 'ELOOP' }, 'a link loop is ELOOP, as stat(2) says');
  assert.equal(await bridge.readFile('/loop/one'), null);

  getSymlinkRegistry(rawVfs).set('/legacy/link.txt', '/real/dir/file.txt');
  assert.equal(
    dec.decode(await bridge.readFile('/legacy/link.txt')),
    'through-directory-link',
    'pre-native registry entries remain readable during compatibility migration',
  );
  assert.equal((await bridge.stat('/legacy/link.txt', { followSymlinks: false })).mode, 0o120777);
  // A registry target's `..` comes after the link before it, as in the kernel:
  // /links/dir is /real/dir, so /links/dir/../side.txt is /real/side.txt.
  await bridge.writeFile('/real/side.txt', 'physical');
  await bridge.writeFile('/links/side.txt', 'lexical');
  getSymlinkRegistry(rawVfs).set('/legacy/up.txt', '/links/dir/../side.txt');
  assert.equal(dec.decode(await bridge.readFile('/legacy/up.txt')), 'physical');

  getSymlinkRegistry(rawVfs).set('/legacy/shadowed.txt', '/real/dir/file.txt');
  vfs.mkdir('legacy', { recursive: true });
  vfs.writeFile('legacy/shadowed.txt', 'native-wins');
  assert.equal(
    dec.decode(await bridge.readFile('/legacy/shadowed.txt')),
    'native-wins',
    'native inodes take precedence over stale legacy registry entries',
  );

  const registry = getSymlinkRegistry(rawVfs);
  registry.set('/legacy/destination-link', '/real/dir/file.txt');
  await assert.rejects(
    async () => bridge.rename('/legacy/missing-source', '/legacy/destination-link'),
    /ENOENT/,
  );
  assert.equal(registry.readlink('/legacy/destination-link'), '/real/dir/file.txt');

  registry.set('/legacy/source-link', '/real/dir/file.txt');
  vfs.writeFile('legacy/native-destination', 'replace-me');
  await bridge.rename('/legacy/source-link', '/legacy/native-destination');
  assert.equal(vfs.lstat('legacy/native-destination').type, 'symlink');
  assert.equal(vfs.readlink('legacy/native-destination'), '/real/dir/file.txt');
  assert.equal(registry.readlink('/legacy/source-link'), null);

  vfs.writeFile('legacy/native-source', 'replacement');
  registry.set('/legacy/shadowed-destination', '/real/dir/file.txt');
  vfs.writeFile('legacy/shadowed-destination', 'old-native');
  await bridge.rename('/legacy/native-source', '/legacy/shadowed-destination');
  assert.equal(vfs.readFileString('legacy/shadowed-destination'), 'replacement');
  assert.equal(registry.readlink('/legacy/shadowed-destination'), null);
}

console.log('runtime-fs-bridge-range: all assertions passed');
