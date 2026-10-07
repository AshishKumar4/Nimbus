#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const handles = [];
function open(h = createSqliteVfsTestHarness()) {
  handles.push(h);
  const raw = new SqliteVFS(h.sql, h.ctx);
  return { h, raw, fs: raw.as(CRED_KERNEL) };
}
function send(src, dst, page, root = '') {
  const frame = src.raw.exportChunks(dst.raw.wantChunks(page));
  assert.equal(frame.rest.length, 0);
  return dst.raw.importPage(root, page, frame.chunks);
}
try {
  const src = open();
  src.fs.writeFile('discarded', 'gap'); src.fs.unlink('discarded');
  src.fs.writeFile('z', 'last by path, first by inode');
  src.fs.mkdir('a'); src.fs.writeFile('a/child', 'child'); src.fs.writeFile('m', 'middle');
  src.raw.snapshot('saved');
  const first = src.raw.exportPage({ at: 'saved', limit: 2 });
  assert.equal(first.rows[0].ino, src.fs.stat(first.rows[0].path).ino, 'export carries real inode identities');
  assert.ok(first.rows.every((row) => row.ino < first.nextIno));
  assert.notEqual(first.next, null);

  const dst = open();
  // Chunk staging before the first page must not turn a fresh identity domain into a used one.
  dst.raw.importChunks('', src.raw.exportChunks(dst.raw.wantChunks(first)).chunks);
  assert.equal(dst.raw.importPage('', first).done, false);
  for (const row of first.rows) assert.equal(dst.fs.stat(row.path).ino, row.ino);
  const cursor = dst.raw.importCursor('');
  dst.fs.writeFile('zz-local', 'ordinary allocation between pages');
  assert.ok(dst.fs.stat('zz-local').ino >= first.nextIno);
  assert.equal(dst.raw.importCursor(''), cursor, 'ordinary allocation cannot skip pending import rows');
  src.fs.writeFile('zz-new-source', 'not part of the pinned snapshot');
  const second = src.raw.exportPage({ at: 'saved', after: cursor, limit: 2 });
  assert.ok(second.nextIno > first.nextIno, 'the source may allocate while exporting its snapshot');
  dst.fs.writeFile(second.rows[0].path, 'concurrent destination file');
  assert.throws(() => send(src, dst, second), (e) => e.code === 'EEXIST');
  assert.equal(dst.fs.readFileString(second.rows[0].path), 'concurrent destination file');
  assert.equal(dst.fs.exists(second.rows[1].path), false);
  dst.fs.unlink(second.rows[0].path);
  const beforeRevision = dst.fs.revision();
  const duplicate = structuredClone(second);
  duplicate.rows[duplicate.rows.length - 1].ino = first.rows[0].ino;
  assert.throws(() => send(src, dst, duplicate), (e) => e.code === 'EEXIST');
  assert.equal(dst.fs.revision(), beforeRevision);
  assert.equal(dst.fs.exists(second.rows[0].path), false, 'a collision does not publish earlier rows in that page');
  const widened = structuredClone(second);
  widened.nextIno += 100;
  widened.rows[0].ino = first.nextIno;
  assert.throws(() => send(src, dst, widened), (e) => e.code === 'EINVAL', 'later headers cannot enlarge the latched inode domain');
  assert.equal(dst.fs.revision(), beforeRevision);
  // Interrupt after a row and its cursor commit together; the caller can replay the whole page.
  const committedCursor = src.raw.exportPage({ at: 'saved', after: cursor, limit: 1 }).next;
  const reset = new Error('simulated caller reset');
  let interrupted = false;
  dst.h.setFaultInjector(({ sql }) => {
    if (!interrupted && sql.startsWith('INSERT OR REPLACE INTO vfs_inodes')) {
      interrupted = true;
      dst.h.failAfterTransaction({ transaction: dst.h.transactionCount, error: reset });
    }
  });
  assert.throws(() => send(src, dst, second), (error) => error === reset);
  dst.h.clearFault();
  const resumed = open(createSqliteVfsTestHarness(dst.h.db));
  assert.equal(resumed.raw.importCursor(''), committedCursor);
  assert.equal(send(src, resumed, second).done, true);
  for (const row of [...first.rows, ...second.rows]) assert.equal(resumed.fs.stat(row.path).ino, row.ino);
  assert.equal(resumed.fs.readFileString('zz-local'), 'ordinary allocation between pages');
  assert.equal(resumed.fs.exists('zz-new-source'), false);
  resumed.fs.writeFile('zz-after', 'new');
  assert.ok(resumed.fs.stat('zz-after').ino > resumed.fs.stat('zz-local').ino);

  const detached = open();
  send(src, detached, first);
  const handle = detached.raw.openDescription('a/child', CRED_KERNEL, { read: true, write: false });
  const retiredId = handle.ino;
  detached.fs.unlink('a/child');
  const reuse = structuredClone(second);
  reuse.rows[0].ino = retiredId;
  assert.throws(() => send(src, detached, reuse), (e) => e.code === 'EEXIST', 'an unlinked but open inode still owns its identity');
  assert.equal(handle.stat().nlink, 0);
  assert.equal(new TextDecoder().decode(handle.read(0, 5)), 'child');
  assert.equal(detached.fs.exists(reuse.rows[0].path), false);
  handle.close();
  assert.equal(send(src, detached, reuse).done, true, 'fully dead identities need no historical seen-ID table');

  const pinned = open();
  send(src, pinned, first);
  pinned.raw.snapshot('pin');
  pinned.fs.unlink('a/child');
  assert.throws(() => send(src, pinned, reuse), (e) => e.code === 'EEXIST', 'snapshot-pinned inodes still own their identities');
  assert.equal(pinned.raw.at('pin').readFileString('a/child'), 'child');
  pinned.raw.dropSnapshot('pin');
  assert.equal(send(src, pinned, reuse).done, true);

  for (const corrupt of [
    (page) => { page.rows[0].ino = 1; },
    (page) => { page.rows[0].path = ''; },
    (page) => { page.rows[0].ino = -2; },
    (page) => { page.rows[0].ino = 2.5; },
    (page) => { page.rows[0].ino = Number.MAX_SAFE_INTEGER + 1; },
    (page) => { page.rows[0].ino = page.nextIno; },
    (page) => { page.rows[1].ino = page.rows[0].ino; },
    (page) => { page.nextIno = Number.MAX_SAFE_INTEGER + 1; },
    (page) => { page.nextIno = Number.MAX_SAFE_INTEGER; },
  ]) {
    const clean = open(), bad = structuredClone(first);
    corrupt(bad);
    assert.throws(() => send(src, clean, bad), (e) => e.code === 'EINVAL');
    assert.deepEqual(clean.fs.readdir('/'), []);
  }

  const whole = src.raw.exportPage({ at: 'saved' });
  const nearLimit = open();
  send(src, nearLimit, { ...first, nextIno: Number.MAX_SAFE_INTEGER - 5, next: null });
  nearLimit.fs.copyTree('a', 'copied');
  nearLimit.fs.writeFile('last-safe', 'x');
  assert.ok(Number.isSafeInteger(nearLimit.fs.stat('last-safe').ino));
  assert.throws(() => nearLimit.fs.writeFile('overflow', 'no'), (e) => e.code === 'ENOSPC');
  assert.equal(nearLimit.fs.exists('overflow'), false, 'an imported high-water cannot cause rounded inode identities');
  const subtree = open();
  for (let i = 0; i < 20; i++) subtree.fs.writeFile(`sentinel-${i}`, 'x');
  send(src, subtree, whole, 'stage');
  for (const row of whole.rows) assert.notEqual(subtree.fs.stat(`stage/${row.path}`).ino, row.ino, 'staging imports allocate fresh IDs');
  const used = open();
  for (let i = 0; i < 20; i++) { used.fs.writeFile('discarded', 'x'); used.fs.unlink('discarded'); }
  send(src, used, whole);
  for (const row of whole.rows) assert.notEqual(used.fs.stat(row.path).ino, row.ino, 'used-but-empty roots keep their identity domain');

  src.fs.removeRecursive('a'); src.fs.unlink('m'); src.fs.unlink('z');
  src.fs.writeFile('newer', 'raises allocator');
  src.raw.restore('saved');
  src.raw.snapshot('restored');
  const restored = src.raw.exportPage({ at: 'restored' });
  assert.ok(restored.rows.every((row) => row.ino < restored.nextIno));
  const restoredTarget = open();
  send(src, restoredTarget, restored);
  for (const row of restored.rows) assert.equal(restoredTarget.fs.stat(row.path).ino, row.ino, 'restored snapshots remain covered by the allocator bound');

} finally {
  const closed = new Set();
  for (const { db } of handles) if (!closed.has(db)) { db.close(); closed.add(db); }
}
console.log('sqlite-vfs-import-inodes: identity bounds, collisions, interleaved allocation, restart replay and remapping pass');
