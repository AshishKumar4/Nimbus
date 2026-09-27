#!/usr/bin/env bun
// Bounded export pages: a huge manifest crosses pages as fragments, never as one unbounded frame.
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ManifestDigest, chunkHash, hex } from '../../packages/core/src/vfs/content-chunking.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const FRAME = 8 * 1024 * 1024;
const PIECES = 4096;
const handles = [];
const open = (h = createSqliteVfsTestHarness()) => { handles.push(h); const raw = new SqliteVFS(h.sql, h.ctx); return { h, raw, fs: raw.as(CRED_KERNEL) }; };
const frameBytes = (page) => new TextEncoder().encode(JSON.stringify(page)).byteLength;
const drain = (raw) => { for (let i = 0; i < 100; i++) if (raw.runContentMaintenance(64).transactions === 0) return; throw new Error('gc did not settle'); };

try {
  // One 64 KiB chunk referenced 130,000 times: 8.5 GB logical, 64 KiB physical.
  const seed = open();
  seed.fs.mkdir('shared', { mode: 0o2775 }); seed.fs.chown('shared', 0, 1000); seed.fs.chmod('shared', 0o2775); seed.fs.setDefaultAcl('shared', 0o775);
  seed.fs.writeFile('shared/huge', ''); seed.fs.writeFile('zz-after', 'tail');
  seed.raw.snapshot('template');
  const template = seed.raw.exportPage({ at: 'template' });
  const chunk = new Uint8Array(65536).fill(123), rawHash = chunkHash(chunk), hash = hex(rawHash), count = 130_000;
  const digest = new ManifestDigest(); for (let i = 0; i < count; i++) digest.add(rawHash);
  const size = count * chunk.length, key = hex(digest.digest(size));
  const hugeRow = template.rows.find((row) => row.path === 'shared/huge');
  const rowAt = (offset, n) => ({ ...hugeRow, size, manifest: true, contentKey: key, pieceOffset: offset, pieces: Array.from({ length: n }, () => [hash, chunk.length]) });
  const oracle = open();
  let after = null;
  for (let at = 0; at < count; at += PIECES) {
    const n = Math.min(PIECES, count - at), end = at + n;
    const next = end === count ? JSON.stringify(['shared/huge', -1]) : JSON.stringify(['shared/huge', end * chunk.length]);
    const rows = [rowAt(at * chunk.length, n)];
    if (at === 0) rows.unshift(...template.rows.filter((row) => row.path < 'shared/huge'));
    assert.equal(oracle.raw.importPage('', { ...template, after, next, rows }, at === 0 ? [{ hash, data: chunk }] : []).done, false);
    after = next;
  }
  const tail = { ...template, after, next: null, rows: template.rows.filter((row) => row.path > 'shared/huge') };
  assert.equal(oracle.raw.importPage('', tail, seed.raw.exportChunks(oracle.raw.wantChunks(tail)).chunks).done, true);
  assert.equal(oracle.fs.stat('shared/huge').size, size);
  assert.equal(oracle.fs.contentKey('shared/huge'), key);
  assert.equal(oracle.h.sql.exec('SELECT SUM(LENGTH(data)) AS b FROM vfs_chunks')[0].b, chunk.length + 'tail'.length, 'one shared chunk plus the tail file');
  oracle.raw.snapshot('big');

  // Export the whole tree in bounded pages; measure the maximum frame.
  let cursor = null, maxFrame = 0, pages = 0, fragments = 0, pieces = 0;
  const seen = [];
  do {
    const page = oracle.raw.exportPage({ at: 'big', after: cursor });
    const bytes = frameBytes(page);
    maxFrame = Math.max(maxFrame, bytes); pages++;
    assert.ok(bytes <= FRAME, `frame ${bytes} exceeds ${FRAME}`);
    assert.ok(page.rows.reduce((n, row) => n + row.pieces.length, 0) <= PIECES);
    for (const row of page.rows) { if (row.path === 'shared/huge') { fragments++; pieces += row.pieces.length; } seen.push([row.path, row.pieceOffset]); }
    cursor = page.next;
  } while (cursor !== null);
  assert.equal(pieces, count, 'every manifest reference is exported exactly once');
  assert.ok(fragments >= Math.ceil(count / PIECES));
  // A whole-filesystem export has no row for '/' itself; the importer keeps its own root.
  assert.deepEqual(seen.filter(([p]) => p !== 'shared/huge').map(([p]) => p), ['shared', 'zz-after']);
  console.log(JSON.stringify({ pages, fragments, maxFrameBytes: maxFrame, logicalBytes: size }));

  // Replay the exported pages into a fresh store: identity, ACL and content survive; GC runs between fragments.
  const copy = open();
  cursor = null;
  let interrupted = false;
  for (let guard = 0; ; guard++) {
    assert.ok(guard < 64, 'replay must terminate within the page count');
    const page = oracle.raw.exportPage({ at: 'big', after: cursor });
    const want = copy.raw.wantChunks(page);
    const frame = oracle.raw.exportChunks(want);
    assert.equal(frame.rest.length, 0);
    const result = copy.raw.importPage('', page, frame.chunks);
    assert.deepEqual(result.want, [], 'every page applies with the chunks it asked for');
    if (page.next !== null) assert.equal(copy.raw.importCursor(''), page.next, 'an applied page advances to its own next');
    else assert.equal(result.done, true, 'the last page completes the import');
    if (!interrupted && page.rows.some((row) => row.path === 'shared/huge' && row.pieceOffset > 0)) {
      interrupted = true;
      // A reset mid-file: reopen, GC, replay the same page, then continue.
      handles.push(copy.h);
      const reopened = new SqliteVFS(copy.h.sql, copy.h.ctx);
      drain(reopened);
      assert.equal(reopened.as(CRED_KERNEL).exists('shared/huge'), false, 'no inode publishes before the manifest completes');
      assert.equal(reopened.importCursor(''), page.next, 'progress survives the reset');
      assert.equal(reopened.importPage('', page, frame.chunks).done, false, 'replaying the committed fragment is idempotent');
      assert.throws(() => reopened.importPage('', { ...page, rows: page.rows.map((row) => ({ ...row, mtime: row.mtime + 1 })) }), (e) => e.code === 'EINVAL', 'changed metadata inside a pending manifest is refused');
      const skipped = oracle.raw.exportPage({ at: 'big', after: JSON.stringify(['shared/huge', (PIECES * 3) * chunk.length]) });
      if (skipped.rows[0]?.pieceOffset > JSON.parse(page.next)[1]) assert.throws(() => reopened.importPage('', skipped), (e) => e.code === 'EINVAL', 'skipping ahead inside a manifest is refused');
      copy.raw = reopened; copy.fs = reopened.as(CRED_KERNEL);
    }
    if (result.done) break;
    assert.notEqual(page.next, null);
    cursor = page.next;
  }
  assert.equal(copy.fs.stat('shared/huge').size, size);
  assert.equal(copy.fs.stat('shared/huge').ino, oracle.fs.stat('shared/huge').ino, 'fresh whole-root import preserves identities through fragments');
  assert.equal(copy.fs.getDefaultAcl('shared'), 0o775);
  assert.equal(copy.fs.contentKey('shared/huge'), key);
  assert.equal(copy.fs.readFileString('zz-after'), 'tail');
  drain(copy.raw);
  assert.deepEqual(copy.raw._auditContentStore(), { chunks: 0, contents: 0 });
  assert.equal(copy.h.sql.exec("SELECT COUNT(*) AS n FROM vfs_contents WHERE state = 0")[0].n, 0, 'no staging content leaks after completion');

  // A wrong final digest never publishes; the pending manifest stays resumable.
  const wrong = open();
  const firstPage = oracle.raw.exportPage({ at: 'big', limit: 3 });
  wrong.raw.importPage('', firstPage, oracle.raw.exportChunks(wrong.raw.wantChunks(firstPage)).chunks);
  cursor = firstPage.next;
  for (let guard = 0; ; guard++) {
    assert.ok(guard < 64 && cursor !== null, 'the completing fragment must be reached');
    const page = oracle.raw.exportPage({ at: 'big', after: cursor });
    const huge = page.rows.find((row) => row.path === 'shared/huge');
    if (huge && huge.pieceOffset + huge.pieces.length * chunk.length === size) {
      // The content key is latched metadata, so changing it is refused before any digest work.
      const relabeled = { ...page, rows: page.rows.map((row) => row === huge ? { ...row, contentKey: 'f'.repeat(64) } : row) };
      assert.throws(() => wrong.raw.importPage('', relabeled), (e) => e.code === 'EINVAL' && /metadata changed/.test(e.message));
      // Consistent metadata but a reference that does not reproduce the key: refused by the final digest.
      const otherData = new Uint8Array(65536).fill(45), other = hex(chunkHash(otherData));
      const bad = { ...page, rows: page.rows.map((row) => row === huge ? { ...row, pieces: row.pieces.map((p, i) => i === row.pieces.length - 1 ? [other, p[1]] : p) } : row) };
      const before = wrong.h.sql.exec('SELECT COUNT(*) AS n FROM vfs_content_chunks')[0].n;
      assert.throws(() => wrong.raw.importPage('', bad, [{ hash: other, data: otherData }]), (e) => e.code === 'EINVAL' && /digest differs/.test(e.message));
      assert.equal(wrong.h.sql.exec('SELECT COUNT(*) AS n FROM vfs_content_chunks')[0].n, before, 'a rejected page writes nothing');
      assert.equal(wrong.raw.importCursor(''), cursor, 'a rejected page does not move the cursor');
      assert.equal(wrong.fs.exists('shared/huge'), false);
      const chunks = oracle.raw.exportChunks(wrong.raw.wantChunks(page)).chunks;
      assert.equal(wrong.raw.importPage('', page, chunks).done, page.next === null, 'the correct page still applies');
      assert.equal(wrong.fs.stat('shared/huge').size, size);
      break;
    }
    const chunks = oracle.raw.exportChunks(wrong.raw.wantChunks(page)).chunks;
    const applied = wrong.raw.importPage('', page, chunks);
    assert.deepEqual(applied.want, [], 'a missing chunk must not masquerade as progress');
    assert.equal(wrong.raw.importCursor(''), page.next, 'each applied page advances the cursor to its own next');
    cursor = page.next;
  }

  // Metadata alone can exceed a frame: long paths still page within budget, and a single oversize row is a named error.
  const wide = open();
  const name = 'n'.repeat(250);
  for (let d = 0; d < 40; d++) wide.fs.mkdir(`${name}${d}`);
  for (let d = 0; d < 40; d++) for (let f = 0; f < 60; f++) wide.fs.writeFile(`${name}${d}/${name}${f}`, `${d}:${f}`);
  wide.raw.snapshot('wide');
  cursor = null; let rows = 0, widest = 0;
  do { const page = wide.raw.exportPage({ at: 'wide', after: cursor }); widest = Math.max(widest, frameBytes(page)); rows += page.rows.length; cursor = page.next; } while (cursor !== null);
  assert.equal(rows, 40 + 2400, 'every long-path row exported once; the root itself has no row');
  assert.ok(widest <= FRAME);
  assert.throws(() => oracle.raw.importPage('', { ...template, rows: [rowAt(0, PIECES + 1)], next: null }), (e) => e.code === 'E2BIG');
} finally {
  const closed = new Set();
  for (const { db } of handles) if (!closed.has(db)) { db.close(); closed.add(db); }
}
console.log('sqlite-vfs-export-fragments: bounded frames, resumable fragments, digest refusal, GC and identity/ACL preservation pass');
