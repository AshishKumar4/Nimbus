#!/usr/bin/env bun
/**
 * sqlite-vfs-import-abandon — removing an import's destination abandons the
 * import (Kinu, ASK-mounts item 9). An import whose sender stopped after a
 * page keeps a job; removing dst (removeRecursive, rmdir, unlink, or a
 * rename away or over it, of dst or an ancestor) ends that job in the
 * transaction that removes dst and queues the staging the import held, so a
 * new import into dst starts clean and nothing staged is kept. A page of
 * the abandoned import still in flight lands nowhere, not even in the import
 * that replaced it. An import nobody removed still resumes after a reset, an
 * embedder transaction that rolls the removal back keeps its staging, and
 * ending many imports at once stays within a transaction's bounds.
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

// ── The job goes in the transaction that removes dst ───────────────────────
{
  const src = source();
  const dst = target();
  importPages(src, dst, { at: 'first', root: 'proj', dst: 'home/proj', pages: 1 });
  dst.harness.setFaultInjector((statement) => (/DELETE FROM vfs_jobs/.test(statement.sql) ? new Error('reset while abandoning') : null));
  assert.throws(() => dst.vfs.removeRecursive('home/proj'), /reset while abandoning/);
  dst.harness.clearFault();
  const reopened = open(createSqliteVfsTestHarness(dst.harness.db));
  assert.equal(reopened.vfs.exists('home/proj'), true, 'the removal did not commit without the abandonment');
  assert.equal(names(reopened, 'home/proj').length, 9);
  assert.equal(imports(reopened).length, 1, 'nor the abandonment without the removal');
  reopened.vfs.removeRecursive('home/proj');
  assert.deepEqual(imports(reopened), []);
  assert.equal(importPages(src, reopened, { at: 'second', root: 'proj', dst: 'home/proj' }).imported, 41);
  assertClean(reopened, 'atomic');
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
  assert.deepEqual(imports(dst), [], 'a restore that removes the destination ends its import');
  // A snapshot taken mid-import restores the rows, not the import.
  dst.raw.restore('mid');
  assert.equal(names(dst, 'home/proj').length, 9);
  assert.deepEqual(imports(dst), []);
  const late = nextPage(src, dst, { at: 'first', root: 'proj', after: first.next });
  assert.throws(() => dst.raw.importPage('home/proj', late.page, late.chunks), /EINVAL/);
  dst.vfs.removeRecursive('home/proj');
  assert.equal(importPages(src, dst, { at: 'second', root: 'proj', dst: 'home/proj' }).imported, 41);
  assert.equal(text(dst, 'home/proj/f05.txt'), 'v2 5\n');
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
      assert.deepEqual(imports(reopened), [], 'inside it, the removal ended the import');
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
  assert.deepEqual(imports(dst), [], 'every import under the ancestor ended');
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
    assert.deepEqual(imports(dst), [], `${label} ended every import beneath it`);
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
  // A reset after the removal commits, before the import beneath it ends: its
  // first page finds no directory to land in, and lands once there is one.
  dst.harness.setFaultInjector((statement) => (/DELETE FROM vfs_jobs/.test(statement.sql) ? new Error('reset after the removal') : null));
  assert.throws(() => dst.vfs.removeRecursive('home'), /reset after the removal/);
  dst.harness.clearFault();
  const reopened = open(createSqliteVfsTestHarness(dst.harness.db));
  assert.equal(reopened.vfs.exists('home'), false);
  assert.equal(imports(reopened).length, 1, 'the import outlived its directory');
  assert.throws(() => importPages(src, reopened, { at: 'first', root: 'proj', dst: 'home/x', pages: 1 }), /ENOENT/);
  assert.equal(reopened.vfs.exists('home/x'), false, 'nothing landed without a parent');
  reopened.vfs.mkdir('home');
  assert.equal(importPages(src, reopened, { at: 'first', root: 'proj', dst: 'home/x' }).imported, 41);
  assertClean(reopened, 'an import that outlived its directory');
}

console.log('sqlite-vfs-import-abandon: all assertions passed');
