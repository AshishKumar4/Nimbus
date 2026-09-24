#!/usr/bin/env bun
/**
 * sqlite-vfs-export-import — moving a tree between databases (SPEC P4, N15,
 * N16): rows by chunk hash, bytes only for chunks the importer lacks. A
 * round trip matches file by file by content key; an import that a reset
 * interrupts resumes to the identical tree; a non-empty target, a schema
 * mismatch and a tampered chunk are refused; page digests find the pages two
 * databases disagree on.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

function open(harness = createSqliteVfsTestHarness()) {
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  return { harness, raw, vfs: raw.as(CRED_KERNEL) };
}

function random(length, seed) {
  const out = new Uint8Array(length);
  let s = (Math.imul(seed, 2654435761) + 1) >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[i] = s & 255;
  }
  return out;
}

/** A tree of `files` files: mostly small, some manifests, one staged-size file, symlinks and modes. */
function build(vfs, root, files, { large = true } = {}) {
  vfs.mkdir(root, { recursive: true });
  for (let d = 0; d < Math.ceil(files / 100); d++) {
    const dir = `${root}/d${d}`;
    vfs.mkdir(dir);
    const inodes = [];
    const chunks = [];
    for (let i = d * 100; i < Math.min(files, (d + 1) * 100); i++) {
      const data = random(200 + ((i * 131) % 3000), i % 700);
      inodes.push({ path: `${dir}/f${i}`, parentPath: dir, isDir: false, size: data.length, mtime: 1000 + i, mode: i % 3 ? 0o644 : 0o755, chunkCount: 1 });
      chunks.push({ path: `${dir}/f${i}`, chunkId: 0, data });
      if (inodes.length === 40) { vfs.writeBatch({ inodes: inodes.splice(0), chunks: chunks.splice(0) }); }
    }
    if (inodes.length) vfs.writeBatch({ inodes, chunks });
  }
  if (large) {
    vfs.writeFile(`${root}/d0/medium.bin`, random(300_000, 1));
    vfs.writeFile(`${root}/d0/huge.bin`, random(9_000_000, 2));
  }
  vfs.writeFile(`${root}/empty`, '');
  vfs.symlink('d0/f1', `${root}/link`);
  vfs.chmod(`${root}/d0`, 0o750);
}

/** Every path under `root`, relative, with kind, mode, size, mtime and content key. */
function image(vfs, root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const entry of vfs.readdir(dir)) {
      const path = `${dir}/${entry.name}`;
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = vfs.lstat(path);
      out[key] = [entry.type, stat.mode, stat.size, stat.mtimeMs ?? stat.mtime, entry.type === 'directory' ? null : entry.type === 'symlink' ? vfs.readlink(path) : vfs.contentKey(path)];
      if (entry.type === 'directory') walk(path, key);
    }
  };
  walk(root, '');
  return out;
}

/**
 * Move snapshot `at` of `root` from `from` to `dst` in `to`, page by page:
 * the chunks a page lacks go ahead of it in bounded frames (importChunks),
 * then the page names them all.
 */
function transfer(from, to, at, root, dst, { limit, frameBytes } = {}) {
  let after = to.raw.importCursor(dst);
  let bytes = 0;
  let pages = 0;
  let frames = 0;
  for (;;) {
    const page = from.raw.exportPage({ at, root, after, limit });
    let want = to.raw.wantChunks(page);
    for (;;) {
      while (want.length > 0) {
        const frame = from.raw.exportChunks(want, frameBytes);
        to.raw.importChunks(dst, frame.chunks);
        for (const chunk of frame.chunks) bytes += chunk.data.byteLength;
        frames++;
        want = frame.rest;
      }
      const result = to.raw.importPage(dst, page);
      if (result.want.length === 0) break;
      want = result.want;
    }
    pages++;
    if (page.next === null) return { bytes, pages, frames };
    after = page.next;
  }
}

// ── A 10k round trip matches file by file ─────────────────────────────────
{
  const src = open();
  build(src.vfs, 'proj', 10_000);
  src.raw.snapshot('s');
  src.vfs.writeFile('proj/d0/f0', 'written after the snapshot');
  const dst = open();
  dst.vfs.mkdir('home');
  const first = transfer(src, dst, 's', 'proj', 'home/proj', { frameBytes: 1 << 20 });
  assert.ok(first.frames > 10, `the 9 MB file came over in ${first.frames} bounded frames`);
  assert.deepEqual(image(dst.vfs, 'home/proj'), image(src.raw.at('s'), 'proj'), 'the import is the snapshot');
  assert.equal(dst.raw.jobs().length, 0);
  assert.equal(dst.raw._verifyCounters(), null);
  // A second import of the same tree into the same database moves no bytes.
  const second = transfer(src, dst, 's', 'proj', 'home/again');
  assert.equal(second.bytes, 0, 'every chunk is already here');
  assert.ok(first.bytes > 0);
  assert.deepEqual(image(dst.vfs, 'home/again'), image(dst.vfs, 'home/proj'));

  // Page digests: equal where the trees agree, different only where not.
  dst.raw.snapshot('d');
  src.raw.snapshot('now');
  const digests = (side, at, root) => {
    const out = [];
    let after = null;
    for (;;) {
      const { digest, next } = side.raw.pageDigest({ at, root, after });
      out.push(digest);
      if (next === null) return out;
      after = next;
    }
  };
  const a = digests(src, 's', 'proj');
  const b = digests(dst, 'd', 'home/proj');
  assert.deepEqual(a, b, 'identical trees have identical page digests');
  const c = digests(src, 'now', 'proj');
  assert.equal(c.filter((digest, i) => digest !== a[i]).length, 1, 'one changed file changes one page');
}

// ── An import a reset interrupts resumes to the identical tree ────────────
{
  const src = open();
  build(src.vfs, 'p', 300);
  src.raw.snapshot('s');
  const expected = image(src.raw.at('s'), 'p');
  const probe = open();
  const start = probe.harness.transactionCount;
  transfer(src, probe, 's', 'p', 'q', { limit: 60 });
  const transactions = probe.harness.transactionCount - start;
  assert.ok(transactions >= 10, `the import spans ${transactions} transactions`);
  for (let k = 1; k <= transactions; k++) {
    const dst = open();
    dst.harness.failAfterTransaction({ transaction: dst.harness.transactionCount + k, error: new Error(`reset at ${k}`) });
    // A reset inside the maintenance an import triggers is survived, not thrown.
    try { transfer(src, dst, 's', 'p', 'q', { limit: 60 }); } catch (error) { assert.match(String(error), new RegExp(`reset at ${k}`)); }
    dst.harness.clearFault();
    const reopened = open(createSqliteVfsTestHarness(dst.harness.db));
    transfer(src, reopened, 's', 'p', 'q', { limit: 60 });
    assert.deepEqual(image(reopened.vfs, 'q'), expected, `resumed after a reset at ${k}`);
    assert.deepEqual(reopened.raw.jobs(), []);
    assert.equal(reopened.raw._verifyCounters(), null);
    for (let pass = 0; reopened.raw.runContentMaintenance(64).transactions > 0; pass++) assert.ok(pass < 100);
    assert.deepEqual(reopened.raw._auditContentStore(), { chunks: 0, contents: 0 }, `nothing leaked by a reset at ${k}`);
  }
}

// ── Refusals: a non-empty target, a schema mismatch, a tampered chunk ─────
{
  const src = open();
  build(src.vfs, 'p', 50, { large: false });
  src.raw.snapshot('s');
  const page = src.raw.exportPage({ at: 's', root: 'p' });
  const dst = open();
  dst.vfs.mkdir('busy');
  dst.vfs.writeFile('busy/x', 'x');
  assert.throws(() => dst.raw.importPage('busy', page, []), /ENOTEMPTY/);
  dst.vfs.writeFile('file', 'x');
  assert.throws(() => dst.raw.importPage('file', page, []), /EEXIST/);
  assert.throws(() => dst.raw.importPage('fresh', { ...page, schema: 1 }, []), /schema/);
  const want = dst.raw.wantChunks(page);
  const { chunks } = src.raw.exportChunks(want);
  const tampered = chunks.map((chunk, i) => (i === 3 ? { ...chunk, data: Uint8Array.from(chunk.data, (b, j) => (j === 0 ? b ^ 1 : b)) } : chunk));
  const before = dst.harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')[0].n;
  assert.throws(() => dst.raw.importPage('fresh', page, tampered), /does not hash to its name/);
  assert.equal(dst.harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')[0].n, before, 'nothing written');
  assert.equal(dst.vfs.exists('fresh'), false);
  // Without the bytes it needs, an import writes nothing and says what to send.
  const partial = dst.raw.importPage('fresh', page, chunks.slice(1));
  assert.deepEqual(partial.want, [chunks[0].hash]);
  assert.equal(dst.vfs.exists('fresh'), false);
  assert.equal(dst.raw.importPage('fresh', page, chunks).done, true);
}

console.log('sqlite-vfs-export-import: all assertions passed');
