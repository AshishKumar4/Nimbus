#!/usr/bin/env bun
// `fsList` — the enumeration a facet cannot get from anything it is shipped.
//
// The resident store's whole purpose is that a synchronous read cannot MISS,
// and that is only true if the store holds what EXISTS rather than what the
// bundler happened to stage. Every map a facet receives describes the latter,
// so the list has to come from the authority. These are the properties a
// filler depends on and would be silently wrong without.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import {
  FS_LIST_PAGE_LIMIT,
} from '../../packages/core/src/constants.ts';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kfs = vfs.as(CRED_KERNEL);

kfs.mkdir('home/user/project', { recursive: true, mode: 0o755 });
kfs.mkdir('opt/data/deep', { recursive: true, mode: 0o755 });
kfs.writeFile('home/user/project/index.js', 'console.log(1)', { mode: 0o644 });
kfs.writeFile('opt/data/deep/asset.bin', 'X'.repeat(4096), { mode: 0o644 });

// ── It enumerates paths no prefetch bundle would carry ──────────────────────
//
// The non-vacuity of the whole design rests here: `opt/data/deep/asset.bin` is
// outside any working tree the bundler walks. If the list could not see it,
// the store could not hold it, and the first sync read of it would still miss.
const all = kfs.list();
const paths = all.entries.map((e) => e.path);
assert.ok(paths.includes('opt/data/deep/asset.bin'), `list must reach outside the working tree: ${paths}`);
assert.ok(paths.includes('home/user/project/index.js'), 'list must include working-tree files');
assert.equal(all.next, null, 'a listing that fit in one page reports itself complete');

// ── Entries carry the shape a filler needs to pack a bounded batch ──────────
//
// Sizes are not decoration: `fsReadBatch` is bounded by a byte total the
// caller must compute BEFORE it asks, so a list without sizes forces a stat
// per path — the round trip enumeration exists to remove.
const asset = all.entries.find((e) => e.path === 'opt/data/deep/asset.bin');
assert.equal(asset.kind, 'file');
assert.equal(asset.size, 4096, 'size must be the real byte length');
assert.equal(typeof asset.rev, 'number');
const dir = all.entries.find((e) => e.path === 'opt/data/deep');
assert.equal(dir.kind, 'directory', 'directories are listed and marked, so a filler does not fetch them as content');

// ── Per-path revisions are real, and advance only for what mutated ──────────
//
// An undated row can never be invalidated, so it would be served stale
// forever. These revisions are what date it.
const beforeRev = all.entries.find((e) => e.path === 'home/user/project/index.js').rev;
const untouchedBefore = asset.rev;
kfs.writeFile('home/user/project/index.js', 'console.log(2)', { mode: 0o644 });
const after = kfs.list();
const afterRev = after.entries.find((e) => e.path === 'home/user/project/index.js').rev;
const untouchedAfter = after.entries.find((e) => e.path === 'opt/data/deep/asset.bin').rev;
assert.ok(afterRev > beforeRev, `a mutated path's revision must advance (${beforeRev} → ${afterRev})`);
assert.equal(untouchedAfter, untouchedBefore, 'an untouched path keeps its revision');

// ── The page cursor is the store's, and it moves with the clock ─────────────
assert.equal(typeof all.epoch, 'string');
assert.ok(all.epoch.length > 0);
assert.equal(after.epoch, all.epoch, 'the epoch is stable within one incarnation');
assert.ok(after.rev > all.rev, 'the page cursor tracks the authority clock');

// ── Pagination: `after` resumes, and a truncated page says so ───────────────
//
// The contract that matters is that a short page is distinguishable from a
// complete one. A caller that could not tell would treat a partial filesystem
// as the whole one — the same defect class as reading a truncated file as a
// complete one.
const page1 = kfs.list(null, 2);
assert.equal(page1.entries.length, 2);
assert.ok(page1.next !== null, 'a truncated page must advertise a resume key');
assert.equal(page1.next, page1.entries[1].path, 'the resume key is the last entry returned');

const seen = new Set();
let cursor = null;
let pages = 0;
for (;;) {
  const page = kfs.list(cursor, 2);
  for (const e of page.entries) {
    assert.ok(!seen.has(e.path), `pagination must not repeat a path: ${e.path}`);
    seen.add(e.path);
  }
  pages++;
  assert.ok(pages < 100, 'pagination must terminate');
  if (page.next === null) break;
  cursor = page.next;
}
assert.ok(pages > 1, 'the fixture must actually span multiple pages, or this proves nothing');
assert.deepEqual(
  [...seen].sort(),
  [...paths].sort(),
  'paging through the whole listing must yield exactly what one full page did',
);

// ── Ordering is by path, which is what makes `after` a stable resume key ────
const ordered = kfs.list().entries.map((e) => e.path);
assert.deepEqual(ordered, [...ordered].sort(), 'entries must be path-ordered');

// ── An over-large limit is clamped, not honoured or rejected ────────────────
const clamped = kfs.list(null, FS_LIST_PAGE_LIMIT * 10);
assert.ok(clamped.entries.length <= FS_LIST_PAGE_LIMIT);

// ── A credential that cannot traverse a directory is not told what is in it ─
//
// Omission rather than denial: a filler that never learns of a path simply
// misses it and falls through to the supervisor, which denies it in its own
// right. Reporting the path instead would leak the existence of files the
// process has no permission to see.
kfs.mkdir('opt/private', { recursive: true, mode: 0o700 });
kfs.writeFile('opt/private/secret.txt', 'classified', { mode: 0o600 });
kfs.chown('opt/private', 0, 0);
kfs.chown('opt/private/secret.txt', 0, 0);

const nobody = vfs.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 });
const visible = nobody.list().entries.map((e) => e.path);
assert.ok(
  !visible.includes('opt/private/secret.txt'),
  `a path behind a directory the credential cannot traverse must be omitted: ${visible}`,
);
assert.ok(
  kfs.list().entries.map((e) => e.path).includes('opt/private/secret.txt'),
  'the kernel credential must still see it, or the check above proves nothing',
);

console.log('vfs-list-enumeration: ok');
console.log(`  ${all.entries.length} entries, ${pages} pages at limit 2, epoch ${all.epoch.slice(0, 8)}…`);
