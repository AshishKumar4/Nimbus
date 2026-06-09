#!/usr/bin/env bun
// Unit tests for SqliteRuntimeFsBridge range ops (readRange/writeRange/
// truncate), per-path revision semantics (stat().revision, revision(path),
// expectedRevision, handle ESTALE isolation), and symlink resolution
// through the shared per-VFS SymlinkRegistry.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CHUNK_SIZE } from '../../packages/worker/src/constants.ts';

function makeBridge() {
  const db = new Database(':memory:');
  const vfs = new SqliteVFS({ exec(query, ...params) { return db.query(query).all(...params); } });
  return { vfs, bridge: new SqliteRuntimeFsBridge(vfs) };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── readRange / writeRange / truncate basics ──
{
  const { bridge } = makeBridge();
  await bridge.writeFile('/home/user/data.txt', 'hello world');

  assert.equal(dec.decode(await bridge.readRange('/home/user/data.txt', 6, 5)), 'world');
  assert.equal((await bridge.readRange('/home/user/data.txt', 100, 5)).length, 0, 'past EOF clamps to empty');
  assert.equal(await bridge.readRange('/home/user/missing.txt', 0, 5), null, 'missing file reads as null');

  const written = await bridge.writeRange('/home/user/data.txt', 6, enc.encode('WORLD'));
  assert.equal(written, 5);
  assert.equal(dec.decode(await bridge.readFile('/home/user/data.txt')), 'hello WORLD');

  // writeRange creates missing files and parents (like writeFile).
  await bridge.writeRange('/home/user/new/dir/file.bin', 2, enc.encode('xy'));
  const created = await bridge.readFile('/home/user/new/dir/file.bin');
  assert.deepEqual(Array.from(created), [0, 0, 120, 121]);
  assert.equal((await bridge.stat('/home/user/new/dir')).type, 'directory');

  await bridge.truncate('/home/user/data.txt', 5);
  assert.equal(dec.decode(await bridge.readFile('/home/user/data.txt')), 'hello');
  await assert.rejects(bridge.truncate('/home/user/missing.txt', 0), /ENOENT/);
  await bridge.mkdir('/home/user/adir');
  await assert.rejects(bridge.truncate('/home/user/adir', 0), /EISDIR/);
  await assert.rejects(bridge.writeRange('/home/user/adir', 0, enc.encode('x')), /EISDIR/);
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
    bridge.writeFile('/a/one.txt', 'stale', { expectedRevision: cur }),
    /ESTALE/,
  );
  await assert.rejects(
    bridge.writeRange('/a/one.txt', 0, enc.encode('s'), { expectedRevision: cur }),
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
  const { vfs, bridge } = makeBridge();
  const big = new Uint8Array(CHUNK_SIZE * 2);
  big.fill(9);
  await bridge.writeFile('/wk/big.bin', big);
  vfs.flushAll();

  const handle = await bridge.open('/wk/big.bin', { read: true, write: true });
  // Positional read.
  assert.deepEqual(Array.from(await bridge.read(handle.id, 5, 3)), [9, 9, 9]);
  // Sequential read advances the cursor.
  await bridge.read(handle.id, null, 4);
  assert.equal((await bridge.read(handle.id, null, 0)).length, 0);

  // Positional write inside chunk 1 must flush exactly one chunk.
  const before = vfs.getStats().sql.writes;
  await bridge.write(handle.id, CHUNK_SIZE + 10, enc.encode('zz'));
  vfs.flushAll();
  assert.equal(vfs.getStats().sql.writes - before, 1,
    'a small positional write must rewrite only the touched chunk');
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

  // A same-path external mutation between writes DOES stale the handle.
  await bridge.writeFile('/x/file.txt', 'external');
  await assert.rejects(bridge.write(handle.id, 0, enc.encode('!')), /ESTALE/);
  await bridge.close(handle.id);

  // open with truncate resets content via the boundary-chunk path.
  const tr = await bridge.open('/x/file.txt', { write: true, truncate: true });
  assert.equal((await bridge.stat('/x/file.txt')).size, 0);
  await bridge.close(tr.id);
}

// ── symlinks: range ops resolve through the shared registry ──
{
  const { bridge } = makeBridge();
  await bridge.writeFile('/real/target.txt', 'abcdefgh');
  await bridge.symlink('/real/target.txt', '/links/alias.txt');

  assert.equal(dec.decode(await bridge.readRange('/links/alias.txt', 2, 3)), 'cde');
  await bridge.writeRange('/links/alias.txt', 0, enc.encode('AB'));
  assert.equal(dec.decode(await bridge.readFile('/real/target.txt')), 'ABcdefgh');
  await bridge.truncate('/links/alias.txt', 4);
  assert.equal(dec.decode(await bridge.readFile('/real/target.txt')), 'ABcd');
  assert.equal((await bridge.stat('/links/alias.txt', { followSymlinks: false })).type, 'symlink');
  // revision(link) follows the link target's data path.
  assert.equal(await bridge.revision('/links/alias.txt'), await bridge.revision('/real/target.txt'));
}

console.log('runtime-fs-bridge-range: all assertions passed');
