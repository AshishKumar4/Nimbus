#!/usr/bin/env bun
/**
 * sqlite-vfs-import-abandon — removing an import's destination abandons the
 * import (Kinu, ASK-mounts item 9). An import whose sender stopped after a
 * page keeps a job; removing dst (removeRecursive, rmdir, unlink, or a
 * rename away or over it, of dst or an ancestor) ends that job: the job
 * records the inodes dst's parent and dst resolved to, and a removal that
 * commits leaves its path resolving elsewhere, so the removal is the
 * invalidation. From then no page, frame or cursor sees the job, a new
 * import into dst starts clean, and a sweep reclaims the job's row and
 * staging so nothing staged is kept. A page of the abandoned import still in
 * flight lands nowhere, not even in the import that replaced it, and not
 * after a crash before the sweep. An import nobody removed still resumes
 * after a reset, and an embedder transaction that rolls the removal back
 * keeps it whole.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { MAX_TX_SQL_EXECS } from '../../packages/platform/src/limits.ts';
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

const text = (side, path) => new TextDecoder().decode(side.vfs.readFile(path));
const exportCursor = (path, offset = -1) => JSON.stringify([path, offset]);
const imports = (side) => side.raw.jobs().filter((job) => job.kind === 'import');
const stagingContents = (side) => side.harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_contents WHERE state = 0')[0].n;
const names = (side, path) => side.vfs.readdir(path).map((entry) => entry.name);

/** The next page of snapshot `at` of `root` after `after`, with the chunks `to` lacks. */
function nextPage(from, to, { at, root, after = null, limit = 10 }) {
  const page = from.raw.exportPage({ at, root, after, limit });
  const want = to.raw.wantChunks(page);
  return { page, chunks: want.length > 0 ? from.raw.exportChunks(want).chunks : [] };
}

/** Import snapshot `at` of `root` into `dst`, a page at a time from `after`, at most `pages` pages. */
function importPages(from, to, { at, root, dst, after = null, limit = 10, pages = Infinity }) {
  let imported = 0;
  for (let n = 0; n < pages; n++) {
    const { page, chunks } = nextPage(from, to, { at, root, after, limit });
    const result = to.raw.importPage(dst, page, chunks);
    assert.deepEqual(result.want, []);
    imported += result.imported;
    if (page.next === null) return { imported, next: null };
    after = page.next;
  }
  return { imported, next: after };
}

function collect(side) {
  for (let pass = 0; side.raw.runContentMaintenance(64).transactions > 0; pass++) assert.ok(pass < 100);
}

/** Nothing staged is kept and nothing leaked. */
function assertClean(side, label) {
  collect(side);
  assert.equal(stagingContents(side), 0, `${label}: no staging content is kept`);
  assert.deepEqual(side.raw._auditContentStore(), { chunks: 0, contents: 0 }, `${label}: nothing leaked`);
  assert.equal(side.raw._verifyCounters(), null, `${label}: counters`);
}

/** `proj` with 40 files: snapshot 'first' at v1, then 'second' at v2. */
function source() {
  const src = open();
  src.vfs.mkdir('proj');
  const file = (i) => `proj/f${String(i).padStart(2, '0')}.txt`;
  for (let i = 0; i < 40; i++) src.vfs.writeFile(file(i), `v1 ${i}\n`);
  src.raw.snapshot('first');
  for (let i = 0; i < 40; i++) src.vfs.writeFile(file(i), `v2 ${i}\n`);
  src.raw.snapshot('second');
  return src;
}

function target(dir = 'home') {
  const dst = open();
  dst.vfs.mkdir(dir, { recursive: true });
  return dst;
}

// ── The ask: an interrupted import, removed, starts again clean ─────────────
{
  const src = source();
  const dst = target();
  const first = importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/proj', pages: 1 });
  assert.equal(first.imported, 10);
  assert.equal(dst.raw.importCursor('home/proj'), first.next);
  dst.vfs.removeRecursive('home/proj');
  assert.deepEqual(imports(dst), [], 'removing the destination ends its import');
  assert.equal(dst.raw.importCursor('home/proj'), null, 'nothing is imported there');
  const second = importPages(src, dst, { at: 'second', root: 'proj', dst: 'home/proj' });
  assert.equal(second.imported, 41, 'the new import takes every row');
  assert.equal(text(dst, 'home/proj/f05.txt'), 'v2 5\n');
  assert.deepEqual(imports(dst), []);
  assertClean(dst, 'removeRecursive');
}

// ── The removal is the invalidation; the sweep only reclaims ──────────────
{
  const src = source();
  const dst = target();
  const first = importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/proj', pages: 1 });
  // A removal that does not commit leaves the import as it was.
  dst.harness.setFaultInjector((statement) => (/^DELETE FROM vfs_inodes/.test(statement.sql) ? new Error('reset while removing') : null));
  assert.throws(() => dst.vfs.removeRecursive('home/proj'), /reset while removing/);
  dst.harness.clearFault();
  const reopened = open(createSqliteVfsTestHarness(dst.harness.db));
  assert.equal(names(reopened, 'home/proj').length, 9, 'the removal did not commit');
  assert.equal(reopened.raw.importCursor('home/proj'), first.next, 'nor did the import end');
  // One that commits ends it, whether or not the sweep after it runs.
  reopened.harness.setFaultInjector((statement) => (/^DELETE FROM vfs_jobs/.test(statement.sql) ? new Error('reset before the sweep') : null));
  reopened.vfs.removeRecursive('home/proj');
  assert.equal(imports(reopened).length, 1, 'the sweep failed: the row is still there');
  assert.equal(reopened.raw.importCursor('home/proj'), null, 'but nobody sees it');
  const late = nextPage(src, reopened, { at: 'first', root: 'proj', after: first.next });
  assert.throws(() => reopened.raw.importPage('home/proj', late.page, late.chunks), /EINVAL/);
  reopened.harness.clearFault();
  const again = open(createSqliteVfsTestHarness(dst.harness.db));
  assert.deepEqual(imports(again), [], 'the next open sweeps it');
  assert.equal(importPages(src, again, { at: 'second', root: 'proj', dst: 'home/proj' }).imported, 41);
  assertClean(again, 'the removal is the invalidation');
}

// ── A rename away ends it; the dead import's next page lands nowhere ───────
{
  const src = source();
  const dst = target();
  const first = importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/proj', pages: 1 });
  dst.vfs.rename('home/proj', 'home/kept');
  assert.deepEqual(imports(dst), [], 'a rename away ends the import');
  assert.equal(dst.raw.importCursor('home/proj'), null);
  assert.equal(names(dst, 'home/kept').length, 9, 'what it imported moved with the name');
  // Its sender's next page, in flight in another request, is refused.
  const late = nextPage(src, dst, { at: 'first', root: 'proj', after: first.next });
  assert.throws(() => dst.raw.importPage('home/proj', late.page, late.chunks), /EINVAL/);
  assert.equal(dst.vfs.exists('home/proj'), false, 'and wrote nothing');
  // Another tree renamed in is not that import's to continue.
  dst.vfs.mkdir('home/other');
  dst.vfs.writeFile('home/other/a.txt', 'other\n');
  dst.vfs.rename('home/other', 'home/proj');
  assert.throws(() => dst.raw.importPage('home/proj', late.page, late.chunks), /EINVAL/);
  assert.deepEqual(names(dst, 'home/proj'), ['a.txt'], 'the tree renamed in is as it was');
  assert.throws(() => importPages(src, dst, { at: 'second', root: 'proj', dst: 'home/proj' }), /ENOTEMPTY/);
  dst.vfs.removeRecursive('home/proj');
  assert.equal(importPages(src, dst, { at: 'second', root: 'proj', dst: 'home/proj' }).imported, 41);
  assertClean(dst, 'rename away');
}

// ── Removing an ancestor, rmdir, a rename over dst, unlink ─────────────────
{
  const src = source();
  const dst = target('home/a');
  importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/a/proj', pages: 1 });
  dst.vfs.removeRecursive('home');
  assert.deepEqual(imports(dst), [], 'removing an ancestor ends the import below it');

  // Two imports that have written only their root directory.
  dst.vfs.mkdir('home');
  importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/p1', limit: 1, pages: 1 });
  importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/p2', limit: 1, pages: 1 });
  assert.deepEqual(imports(dst).map((job) => job.args.dst), ['home/p1', 'home/p2']);
  dst.vfs.rmdir('home/p1');
  assert.deepEqual(imports(dst).map((job) => job.args.dst), ['home/p2'], 'rmdir ends only its own import');
  dst.vfs.mkdir('home/empty');
  dst.vfs.rename('home/empty', 'home/p2');
  assert.deepEqual(imports(dst), [], 'a rename over the destination ends its import');

  // Chunks sent ahead of an import's pages are released with it.
  const { chunks } = nextPage(src, dst, { at: 'second', root: 'proj' });
  assert.equal(dst.raw.importChunks('home/f', chunks).stored, chunks.length);
  assert.ok(stagingContents(dst) > 0, 'the chunks are staged for the import');
  dst.vfs.writeFile('home/f', 'a file at the destination\n');
  dst.vfs.unlink('home/f');
  assert.deepEqual(imports(dst), [], 'unlink ends the import');
  assertClean(dst, 'chunks sent ahead');
  // Children of a destination are not the destination.
  importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/p3', pages: 1 });
  dst.vfs.unlink('home/p3/f00.txt');
  assert.equal(imports(dst).length, 1, 'removing a child keeps the import');
}

// ── A manifest staged when the import stopped is released with it ──────────
{
  const src = open();
  src.vfs.mkdir('big');
  src.vfs.writeFile('big/a.bin', random(4_000_000, 1));
  src.vfs.writeFile('big/b.txt', 'b\n');
  src.raw.snapshot('s');
  let found = false;
  for (let k = 1; !found; k++) {
    assert.ok(k < 60, 'some reset leaves a manifest mid-import');
    const dst = target();
    dst.harness.failAfterTransaction({ transaction: dst.harness.transactionCount + k, error: new Error(`reset at ${k}`) });
    try { importPages(src, dst, { at: 's', root: 'big', dst: 'home/big' }); } catch (error) { assert.match(String(error), new RegExp(`reset at ${k}`)); }
    dst.harness.clearFault();
    const reopened = open(createSqliteVfsTestHarness(dst.harness.db));
    if (imports(reopened)[0]?.args.pending === undefined) continue;
    found = true;
    assert.ok(stagingContents(reopened) > 0, 'the manifest so far is staged');
    reopened.vfs.removeRecursive('home/big');
    assert.deepEqual(imports(reopened), []);
    assertClean(reopened, `a manifest staged at reset ${k}`);
    importPages(src, reopened, { at: 's', root: 'big', dst: 'home/big' });
    assert.equal(reopened.vfs.contentKey('home/big/a.bin'), src.raw.at('s').contentKey('big/a.bin'));
    assertClean(reopened, `re-imported after reset ${k}`);
  }
}

// ── A reset without a removal still resumes, and a replay is harmless ──────
{
  const src = source();
  const dst = target();
  importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/proj', pages: 2 });
  const reopened = open(createSqliteVfsTestHarness(dst.harness.db));
  assert.equal(imports(reopened).length, 1);
  assert.equal(importPages(src, reopened, { at: 'first', root: 'proj', dst: 'home/proj' }).imported, 21, 'a replay from the first page skips what committed');
  assert.equal(text(reopened, 'home/proj/f05.txt'), 'v1 5\n');
  assert.equal(names(reopened, 'home/proj').length, 40);
  assertClean(reopened, 'resumed');
}

// ── Snapshots and restore ──────────────────────────────────────────────────
{
  const src = source();
  const dst = target();
  dst.raw.snapshot('before');
  const first = importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/proj', pages: 1 });
  dst.raw.snapshot('mid');
  dst.raw.restore('before');
  assert.equal(dst.vfs.exists('home/proj'), false);
  assert.equal(dst.raw.importCursor('home/proj'), null, 'a restore that removes the destination ends its import');
  // A snapshot taken mid-import restores the rows, not the import: not even
  // before the sweep, when the restore brings back the inodes it began at.
  dst.raw.restore('mid');
  assert.equal(names(dst, 'home/proj').length, 9);
  assert.equal(imports(dst).length, 1, 'no sweep has run yet');
  assert.equal(dst.raw.importCursor('home/proj'), exportCursor('f08.txt'), 'the cursor is the restored rows\', not the import\'s');
  const late = nextPage(src, dst, { at: 'first', root: 'proj', after: first.next });
  assert.throws(() => dst.raw.importPage('home/proj', late.page, late.chunks), /EINVAL/);
  collect(dst);
  assert.deepEqual(imports(dst), [], 'the sweep reclaims it');
  dst.vfs.removeRecursive('home/proj');
  assert.equal(importPages(src, dst, { at: 'second', root: 'proj', dst: 'home/proj' }).imported, 41);
  assert.equal(text(dst, 'home/proj/f05.txt'), 'v2 5\n');
  // A restore of a subtree beneath an open import rewinds its rows: it ends the import too.
  dst.vfs.removeRecursive('home/proj');
  dst.vfs.mkdir('home/proj');
  dst.vfs.mkdir('home/proj/d');
  dst.raw.snapshot('empty');
  dst.vfs.removeRecursive('home/proj');
  importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/proj', pages: 1 });
  dst.vfs.mkdir('home/proj/d');
  dst.raw.restore('empty', { subtree: 'home/proj/d' });
  assert.equal(dst.raw.importCursor('home/proj'), exportCursor('f08.txt'));
  assert.throws(() => importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/proj', after: exportCursor('f08.txt') }), /EINVAL/);
  dst.raw.dropSnapshot('empty');
  dst.vfs.removeRecursive('home/proj');
  dst.raw.dropSnapshot('before');
  dst.raw.dropSnapshot('mid');
  assertClean(dst, 'restore');
}

// ── A late page of the ended import never joins the one that replaced it ──
{
  const src = source();
  const dst = target();
  const v1 = importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/proj', pages: 1 });
  dst.vfs.removeRecursive('home/proj');
  // Both exports are taken after both snapshots exist: root and allocator headers agree.
  const v2 = importPages(src, dst, { at: 'second', root: 'proj', dst: 'home/proj', pages: 1 });
  assert.equal(v2.next, v1.next, 'the new import stands where the old one stopped');
  const late = nextPage(src, dst, { at: 'first', root: 'proj', after: v1.next });
  assert.throws(() => dst.raw.importPage('home/proj', late.page, late.chunks), /EINVAL: home\/proj: an import of another export is open here/);
  assert.equal(dst.vfs.exists('home/proj/f15.txt'), false, 'the late page wrote nothing');
  assert.equal(importPages(src, dst, { at: 'second', root: 'proj', dst: 'home/proj', after: v2.next }).imported, 31);
  assert.equal(text(dst, 'home/proj/f15.txt'), 'v2 15\n');
  // A first page of another export is not a replay of the open import's.
  dst.vfs.removeRecursive('home/proj');
  importPages(src, dst, { at: 'second', root: 'proj', dst: 'home/proj', pages: 1 });
  const other = nextPage(src, dst, { at: 'first', root: 'proj' });
  assert.throws(() => dst.raw.importPage('home/proj', other.page, other.chunks), /another export is open here/);
  // Chunks sent ahead begin a job no page has written: the first page names its export.
  const ahead = nextPage(src, dst, { at: 'second', root: 'proj' });
  dst.raw.importChunks('home/ahead', ahead.chunks);
  assert.equal(dst.raw.importPage('home/ahead', ahead.page, []).imported, 10);
  assert.throws(() => dst.raw.importPage('home/ahead', nextPage(src, dst, { at: 'first', root: 'proj', after: ahead.page.next }).page, []),
    /another export is open here/);
  dst.vfs.removeRecursive('home/proj');
  dst.vfs.removeRecursive('home/ahead');
  assertClean(dst, 'another export');
}

// ── An embedder transaction that rolls back keeps the import's staging ─────
{
  const src = open();
  src.vfs.mkdir('big');
  src.vfs.writeFile('big/a.bin', random(4_000_000, 3));
  src.vfs.writeFile('big/b.txt', 'b\n');
  src.raw.snapshot('s');
  let found = false;
  for (let k = 1; !found; k++) {
    assert.ok(k < 60, 'some reset leaves a manifest mid-import');
    const dst = target();
    dst.harness.failAfterTransaction({ transaction: dst.harness.transactionCount + k, error: new Error(`reset at ${k}`) });
    try { importPages(src, dst, { at: 's', root: 'big', dst: 'home/big' }); } catch (error) { assert.match(String(error), new RegExp(`reset at ${k}`)); }
    dst.harness.clearFault();
    const reopened = open(createSqliteVfsTestHarness(dst.harness.db));
    if (imports(reopened)[0]?.args.pending === undefined) continue;
    found = true;
    assert.throws(() => reopened.raw.withTransaction(() => {
      reopened.vfs.removeRecursive('home/big');
      assert.equal(reopened.raw.importCursor('home/big'), null, 'inside it, the removal ended the import');
      throw new Error('the embedder gives up');
    }), /rolled back/);
    assert.equal(imports(reopened).length, 1, 'the rollback brought the job back');
    collect(reopened);
    importPages(src, reopened, { at: 's', root: 'big', dst: 'home/big' });
    assert.equal(reopened.vfs.contentKey('home/big/a.bin'), src.raw.at('s').contentKey('big/a.bin'), 'the import resumed on its staging');
    assertClean(reopened, `resumed after a rollback at reset ${k}`);
    // Committed, the same removal releases what the import staged.
    reopened.vfs.removeRecursive('home/big');
    const again = open(createSqliteVfsTestHarness(dst.harness.db));
    let staged = false;
    for (let j = 1; !staged; j++) {
      assert.ok(j < 60);
      again.harness.failAfterTransaction({ transaction: again.harness.transactionCount + j, error: new Error(`reset at ${j}`) });
      try { importPages(src, again, { at: 's', root: 'big', dst: 'home/big' }); } catch (error) { assert.match(String(error), new RegExp(`reset at ${j}`)); }
      again.harness.clearFault();
      staged = imports(again)[0]?.args.pending !== undefined;
      if (!staged) { importPages(src, again, { at: 's', root: 'big', dst: 'home/big' }); again.vfs.removeRecursive('home/big'); }
    }
    again.raw.withTransaction(() => { again.vfs.removeRecursive('home/big'); });
    assert.deepEqual(imports(again), []);
    assertClean(again, 'a committed embedder transaction');
  }
}

// ── Ending many imports stays inside one transaction's bounds ──────────────
{
  const src = source();
  const dst = target('home/anc');
  for (let i = 0; i < 75; i++) importPages(src, dst, { at: 'first', root: 'proj', dst: `home/anc/p${i}`, limit: 1, pages: 1 });
  assert.equal(imports(dst).length, 75);
  const firstTransaction = dst.harness.transactionCount;
  const firstStatement = dst.harness.statements.length;
  const planned = new Map();
  dst.raw.getStats(); // loads the counters, so reading them below issues no SQL
  dst.harness.setFaultInjector(({ transaction }) => {
    if (transaction !== null && transaction > firstTransaction && !planned.has(transaction)) {
      planned.set(transaction, dst.raw.getStats().sql.transactions.sqlExecs.current);
    }
    return null;
  });
  dst.vfs.removeRecursive('home/anc');
  dst.harness.clearFault();
  for (let i = 0; i < 75; i++) assert.equal(dst.raw.importCursor(`home/anc/p${i}`), null, 'every import under the ancestor ended');
  const executed = new Map();
  for (const statement of dst.harness.statements.slice(firstStatement)) {
    if (statement.transaction !== null) executed.set(statement.transaction, (executed.get(statement.transaction) ?? 0) + 1);
  }
  for (const [transaction, count] of executed) {
    assert.ok(count <= MAX_TX_SQL_EXECS, `transaction ${transaction} ran ${count} statements, over the ${MAX_TX_SQL_EXECS} bound`);
    assert.ok(count <= planned.get(transaction), `transaction ${transaction} ran ${count} statements, planned ${planned.get(transaction)}`);
  }
  assertClean(dst, 'many imports');
}

// ── A rollback brings back the staging a new import displaced ─────────────
{
  const src = source();
  const dst = target();
  // Chunks sent ahead, then the first page: the import holds a staging of its own.
  const first = nextPage(src, dst, { at: 'first', root: 'proj' });
  assert.ok(dst.raw.importChunks('home/proj', first.chunks).stored > 0);
  assert.equal(dst.raw.importPage('home/proj', first.page, []).imported, 10);
  assert.throws(() => dst.raw.withTransaction(() => {
    dst.vfs.removeRecursive('home/proj');
    // Another export's root page begins a new import there.
    assert.equal(importPages(src, dst, { at: 'second', root: 'proj', dst: 'home/proj', limit: 1, pages: 1 }).imported, 1);
    throw new Error('the embedder gives up');
  }), /rolled back/);
  assert.equal(imports(dst).length, 1, 'the first import is back');
  assert.equal(importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/proj', after: first.page.next }).imported, 31);
  assert.equal(text(dst, 'home/proj/f15.txt'), 'v1 15\n');
  dst.vfs.removeRecursive('home/proj');
  assertClean(dst, 'a displaced staging, restored');
}

// ── Imports with no destination yet end in bounded groups ─────────────────
{
  const src = open();
  src.vfs.mkdir('c');
  for (let i = 0; i < 150; i++) src.vfs.writeFile(`c/f${i}`, `chunk ${i}\n`);
  src.raw.snapshot('s');
  const page = src.raw.exportPage({ at: 's', root: 'c' });
  const chunks = src.raw.exportChunks(page.rows.flatMap((row) => row.pieces.map(([hash]) => hash))).chunks;
  assert.equal(chunks.length, 150);
  for (const [label, remove] of [['removeRecursive', (side) => side.vfs.removeRecursive('home')], ['rmdir', (side) => side.vfs.rmdir('home')]]) {
    const dst = target();
    // Chunks sent ahead of each import's first page: a job and a staging, no destination.
    for (let i = 0; i < 150; i++) dst.raw.importChunks(`home/d${i}`, [chunks[i]]);
    assert.equal(imports(dst).length, 150);
    const firstStatement = dst.harness.statements.length;
    remove(dst);
    assert.equal(dst.vfs.exists('home'), false, `${label} removed home`);
    for (let i = 0; i < 150; i++) assert.throws(() => dst.raw.importChunks(`home/d${i}`, [chunks[i]]), (error) => error.code === 'ENOENT');
    assert.ok(imports(dst).length > 0, `${label}: the sweep after the removal took only its allowance`);
    const executed = new Map();
    for (const statement of dst.harness.statements.slice(firstStatement)) {
      if (statement.transaction !== null) executed.set(statement.transaction, (executed.get(statement.transaction) ?? 0) + 1);
    }
    for (const count of executed.values()) assert.ok(count <= MAX_TX_SQL_EXECS, `${label}: ${count} statements in one transaction`);
    assertClean(dst, label);
  }
}

// ── Ending an import is cleanup: a full store, a refused batch, a reset ───
{
  const src = source();
  const { chunks } = nextPage(src, target(), { at: 'first', root: 'proj' });
  const harness = createSqliteVfsTestHarness();
  const probe = new SqliteVFS(harness.sql, harness.ctx);
  probe.as(CRED_KERNEL).mkdir('home/d', { recursive: true });
  const raw = new SqliteVFS(harness.sql, harness.ctx, undefined, { storageLimit: probe.databaseBytes() + 1_048_576, storageKernelReserve: 0 });
  const dst = { harness, raw, vfs: raw.as(CRED_KERNEL) };
  dst.raw.importChunks('home/d/x', [chunks[0]]);
  dst.raw.ledger.fill('full', dst.raw.ledger.limit - dst.raw.ledger.view().used);
  assert.throws(() => dst.vfs.writeFile('home/grow', 'x'), (error) => error.code === 'ENOSPC', 'the store is full');
  dst.vfs.rmdir('home/d');
  assert.deepEqual(imports(dst), [], 'a full store still ends the import beneath a removed directory');
  dst.raw.ledger.deleteFacet('full');
  assertClean(dst, 'a full store');
}
{
  const src = source();
  const dst = target();
  const { chunks } = nextPage(src, dst, { at: 'first', root: 'proj' });
  dst.raw.importChunks('home/x', [chunks[0]]);
  const rows = Array.from({ length: 300 }, (_, i) => ({ path: `top${i}`, parentPath: '', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 }));
  assert.throws(() => dst.vfs.writeBatch({ inodes: rows, chunks: [], deletePaths: ['home'] }), (error) => error.code === 'E2BIG');
  assert.equal(dst.vfs.exists('home'), true, 'a refused batch removes nothing');
  assert.equal(imports(dst).length, 1, 'and ends no import');
}

// ── A crash between the removal and the sweep (PossibleOpossum's repro) ────
// A 4 MB file imported into home/big.bin stops mid-manifest: there is no
// inode at dst yet. rmdir('home') commits and the process dies before the
// sweep. The sender's resend neither completes the old import nor lands
// under the missing parent, in that life or the next; once home is made
// again, the same page is a new import of its own.
{
  const src = open();
  src.vfs.writeFile('big.bin', random(4_000_000, 5));
  src.raw.snapshot('s');
  const resend = (side) => importPages(src, side, { at: 's', root: 'big.bin', dst: 'home/big.bin' });
  let found = false;
  for (let k = 1; !found; k++) {
    assert.ok(k < 60, 'some reset leaves the file mid-manifest');
    const dst = target();
    dst.harness.failAfterTransaction({ transaction: dst.harness.transactionCount + k, error: new Error(`reset at ${k}`) });
    try { resend(dst); } catch (error) { assert.match(String(error), new RegExp(`reset at ${k}`)); }
    dst.harness.clearFault();
    const reopened = open(createSqliteVfsTestHarness(dst.harness.db));
    if (imports(reopened)[0]?.args.pending === undefined) continue;
    found = true;
    assert.equal(reopened.vfs.exists('home/big.bin'), false, 'nothing at dst yet');
    reopened.harness.setFaultInjector((statement) => (/^DELETE FROM vfs_jobs/.test(statement.sql) ? new Error('crash before the sweep') : null));
    reopened.vfs.rmdir('home');
    assert.equal(reopened.vfs.exists('home'), false);
    assert.throws(() => resend(reopened), (error) => error.code === 'ENOENT', 'the resend, in the same life');
    reopened.harness.clearFault();
    const after = open(createSqliteVfsTestHarness(dst.harness.db));
    assert.deepEqual(imports(after), [], 'the next open ends it');
    assert.throws(() => resend(after), (error) => error.code === 'ENOENT', 'the resend, after the crash');
    assert.equal(after.harness.sql.exec("SELECT COUNT(*) AS n FROM vfs_inodes WHERE path LIKE 'home%'")[0].n, 0, 'no inode landed under the missing parent');
    after.vfs.mkdir('home');
    resend(after);
    assert.equal(after.vfs.contentKey('home/big.bin'), src.raw.at('s').contentKey('big.bin'));
    assertClean(after, 'a crash between the removal and the sweep');
  }
}

// ── Where the import began is a path and an inode, not either alone ────────
// Each of these leaves the import's paths resolving, just not to what it
// began in; the check compares the inode each path resolves to now.
{
  // An ancestor renamed away: its inode survives, at another path. One
  // import has written its destination, the other has only sent chunks.
  const src = source();
  const dst = target('home/a');
  const first = importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/a/proj', pages: 1 });
  const ahead = nextPage(src, dst, { at: 'second', root: 'proj' });
  dst.raw.importChunks('home/a/next', ahead.chunks);
  dst.vfs.rename('home/a', 'home/b');
  assert.deepEqual(imports(dst), [], 'renaming an ancestor away ends both imports');
  const late = nextPage(src, dst, { at: 'first', root: 'proj', after: first.next });
  assert.throws(() => dst.raw.importPage('home/a/proj', late.page, late.chunks), /EINVAL/);
  assert.throws(() => dst.raw.importPage('home/a/next', ahead.page, []), (error) => error.code === 'ENOENT');
  assert.equal(dst.vfs.exists('home/a'), false, 'nothing landed where the ancestor was');
  assert.deepEqual(names(dst, 'home/b'), ['proj'], 'nor in the directory that moved');
  assert.equal(names(dst, 'home/b/proj').length, 9);
  assertClean(dst, 'an ancestor renamed away');
}
{
  // rmdir then mkdir of the parent, in one transaction: the path is back, with a new inode.
  const src = source();
  const dst = target('home/d');
  const { chunks } = nextPage(src, dst, { at: 'first', root: 'proj' });
  dst.raw.importChunks('home/d/proj', chunks);
  dst.raw.withTransaction(() => {
    dst.vfs.rmdir('home/d');
    dst.vfs.mkdir('home/d');
  });
  assert.deepEqual(imports(dst), [], 'a directory made again is not the one the import began in');
  assertClean(dst, 'rmdir then mkdir');
  assert.equal(importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/d/proj' }).imported, 41, 'a new import lands there');
}
{
  // Another directory renamed into dst, in one transaction with dst's removal.
  const src = source();
  const dst = target();
  const first = importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/proj', pages: 1 });
  dst.raw.withTransaction(() => {
    dst.vfs.rename('home/proj', 'home/kept');
    dst.vfs.mkdir('home/other');
    dst.vfs.writeFile('home/other/a.txt', 'other\n');
    dst.vfs.rename('home/other', 'home/proj');
  });
  assert.deepEqual(imports(dst), [], 'a directory renamed in is not the import\'s');
  const late = nextPage(src, dst, { at: 'first', root: 'proj', after: first.next });
  assert.throws(() => dst.raw.importPage('home/proj', late.page, late.chunks), /EINVAL/);
  assert.deepEqual(names(dst, 'home/proj'), ['a.txt'], 'the tree renamed in is as it was');
  assert.equal(names(dst, 'home/kept').length, 9);
  assertClean(dst, 'a directory renamed in');
}

// ── The sweep takes the maintenance allowance, zero included ──────────────
{
  const src = source();
  const dst = target();
  const { chunks } = nextPage(src, dst, { at: 'first', root: 'proj' });
  for (let i = 0; i < 150; i++) dst.raw.importChunks(`home/d${i}`, [chunks[i % chunks.length]]);
  dst.harness.setFaultInjector((statement) => (/^DELETE FROM vfs_jobs/.test(statement.sql) ? new Error('no sweep yet') : null));
  dst.vfs.removeRecursive('home');
  dst.harness.clearFault();
  assert.equal(imports(dst).length, 150, 'every import is stale, none swept');
  assert.deepEqual(dst.raw.runContentMaintenance(0), { transactions: 0 });
  assert.equal(imports(dst).length, 150, 'an allowance of zero sweeps nothing');
  assert.deepEqual(dst.raw.runContentMaintenance(1), { transactions: 1 });
  assert.equal(imports(dst).length, 150 - 64, 'one transaction ends one bounded group');
  for (let pass = 0; imports(dst).length > 0; pass++) {
    assert.ok(pass < 10);
    assert.ok(dst.raw.runContentMaintenance(1).transactions <= 1);
  }
  assertClean(dst, 'a budgeted sweep');
}

// ── A job that records no parent is nobody's import ───────────────────────
{
  const src = source();
  const dst = target();
  importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/proj', pages: 1 });
  // The job as a build before this one recorded it: no parent, no source.
  const [job] = imports(dst);
  const { parentIno, dstIno, source: from, ...legacy } = job.args;
  assert.ok(parentIno !== undefined && dstIno !== undefined && from !== undefined);
  dst.harness.sql.exec('UPDATE vfs_jobs SET args = ? WHERE id = ?', JSON.stringify(legacy), job.id);
  const reopened = open(createSqliteVfsTestHarness(dst.harness.db));
  assert.deepEqual(imports(reopened), [], 'the open sweeps it');
  reopened.vfs.removeRecursive('home/proj');
  assert.equal(reopened.raw.importCursor('home/proj'), null);
  assert.equal(importPages(src, reopened, { at: 'second', root: 'proj', dst: 'home/proj' }).imported, 41, 'a first page starts clean');
  assertClean(reopened, 'a job with no parent');
}

// ── A rolled-back import leaves nothing pinned for the ids it used ────────
{
  const src = source();
  const dst = target();
  const first = nextPage(src, dst, { at: 'first', root: 'proj' });
  dst.raw.importChunks('home/proj', first.chunks);
  assert.equal(dst.raw.importPage('home/proj', first.page, []).imported, 10);
  const second = nextPage(src, target(), { at: 'second', root: 'proj' });
  assert.throws(() => dst.raw.withTransaction(() => {
    dst.vfs.removeRecursive('home/proj');
    // A replacement import stages chunks ahead: a job and a content that roll back.
    dst.raw.importChunks('home/proj', second.chunks);
    throw new Error('the embedder gives up');
  }), /rolled back/);
  importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/proj', after: first.page.next });
  dst.vfs.removeRecursive('home/proj');
  collect(dst);
  // A large file takes the content id the rolled-back staging had; removed, it is collected whole.
  dst.vfs.writeFile('home/big.bin', random(100_000, 9));
  dst.vfs.unlink('home/big.bin');
  assertClean(dst, 'a rolled-back import');
  assert.equal(dst.harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_contents')[0].n, 0, 'no content is left pinned');
  assert.equal(dst.harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')[0].n, 0, 'nor any chunk');
}

// ── Mid-way through a sliced restore, the removed ancestor is gone ────────
// restoreAsync removes what changed since the snapshot in gen order, a
// slice at a time: home goes in the first slice, home/a/proj much later.
{
  const src = source();
  const dst = target();
  dst.vfs.rmdir('home');
  dst.raw.snapshot('empty');
  dst.vfs.mkdir('home');
  const fill = [];
  for (let i = 0; i < 42_000; i++) fill.push(`fill/d${i}`);
  dst.vfs.mkdir('fill');
  for (let i = 0; i < fill.length; i += 100) dst.vfs.mkdirBatch(fill.slice(i, i + 100));
  dst.vfs.mkdir('home/a');
  const first = importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/a/proj', pages: 1 });
  const late = nextPage(src, dst, { at: 'first', root: 'proj', after: first.next });
  // The first slice runs in the call; the rest after it yields.
  const restoring = dst.raw.restoreAsync('empty');
  assert.equal(dst.vfs.exists('home'), false, 'the first slice removed home');
  assert.ok(dst.harness.sql.exec("SELECT COUNT(*) AS n FROM vfs_inodes WHERE path = 'home/a/proj'")[0].n === 1, 'and not yet its descendants');
  assert.equal(dst.raw.importCursor('home/a/proj'), null, 'the import shows no progress');
  assert.throws(() => dst.raw.importPage('home/a/proj', late.page, late.chunks), /EINVAL/);
  await restoring;
  assert.equal(dst.harness.sql.exec("SELECT COUNT(*) AS n FROM vfs_inodes WHERE path LIKE 'home%'")[0].n, 0, 'nothing is left under home');
  dst.raw.dropSnapshot('empty');
  collect(dst);
  assert.deepEqual(imports(dst), []);
}

console.log('sqlite-vfs-import-abandon: all assertions passed');
