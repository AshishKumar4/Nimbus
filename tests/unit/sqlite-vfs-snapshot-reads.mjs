#!/usr/bin/env bun
// A snapshot view (SqliteVFS.at) reads as the live tree does, over the tree
// the snapshot pinned, and only while it is pinned:
//   - readdir of a link to a directory lists that directory's entries, as
//     the live readdir (and Linux) does, and keeps listing what the snapshot
//     saw after the live directory changes;
//   - list pages are bounded by their encoded bytes, as the live list's are
//     (fslist-byte-bound): link targets whose JSON escaping makes a full page
//     exceed the RPC frame are split across pages, with none lost;
//   - once its snapshot is dropped, every call is ESTALE: the coherence
//     calls (acquire, invalidatedSince), revision and storageKey too.
//
// Red before: the snapshot's readdir listed the link's own (empty) children,
// its list returned one page past the RPC frame, and acquire, invalidatedSince,
// revision and storageKey answered for a dropped snapshot.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { FS_LIST_PAGE_LIMIT, MAX_RPC_SAFE_PAYLOAD_BYTES } from '../../packages/core/src/constants.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const names = (entries) => entries.map((entry) => entry.name);
const failed = [];
async function check(name, run) {
  try {
    await run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}: ${String(error?.message ?? error).split('\n').slice(0, 3).join(' | ')}`);
    failed.push(name);
  }
}
function engine() {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  return { harness, vfs, fs: vfs.as(CRED_KERNEL) };
}

await check('readdir through a link to a directory', () => {
  const { vfs, fs } = engine();
  fs.mkdir('d');
  fs.writeFile('d/file', enc.encode('x'));
  fs.symlink('d', 'link');
  vfs.snapshot('s');
  fs.writeFile('d/later', enc.encode('y'));
  const view = vfs.at('s');
  assert.deepEqual(names(fs.readdir('link')), ['file', 'later'], 'the live readdir follows the link');
  assert.deepEqual(names(view.readdir('link')), ['file'], 'the snapshot\'s follows it too, to what it saw');
  assert.deepEqual(names(view.readdir('d')), ['file']);
});

await check('list pages bounded by their bytes', async () => {
  const { harness, vfs, fs } = engine();
  try {
    fs.mkdir('home/user/links', { recursive: true });
    // As fslist-byte-bound: below PATH_MAX and NAME_MAX, but escaping makes a count-only page exceed the frame.
    const target = Array(16).fill('x"\\'.repeat(85)).join('/');
    const expected = new Set(['home', 'home/user', 'home/user/links']);
    for (let i = 0; i < 8190; i++) {
      const key = 'home/user/links/link' + String(i).padStart(5, '0');
      fs.symlink(target, key);
      expected.add(key);
    }
    vfs.snapshot('big');
    const view = vfs.at('big');
    const seen = new Set();
    let after = null;
    let pages = 0;
    do {
      const page = await view.list(after, FS_LIST_PAGE_LIMIT);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_RPC_SAFE_PAYLOAD_BYTES, 'a page fits the encoded RPC frame');
      for (const entry of page.entries) {
        assert.ok(!seen.has(entry.path), 'no entry twice');
        seen.add(entry.path);
      }
      if (page.next !== null) assert.equal(page.next, page.entries.at(-1).path);
      after = page.next;
      assert.ok(++pages < 10, 'the listing ends');
    } while (after !== null);
    assert.deepEqual(seen, expected, 'no name lost');
    assert.ok(pages > 1, 'the frame is split');
  } finally {
    harness.db.close();
  }
});

await check('every call of a dropped snapshot\'s view is ESTALE', () => {
  const { vfs, fs } = engine();
  fs.writeFile('f', enc.encode('x'));
  vfs.snapshot('p');
  const view = vfs.at('p');
  const g = view.revision();
  assert.equal(view.acquire(view.epoch, g).poison, false, 'pinned: a cursor at it learns nothing');
  vfs.dropSnapshot('p');
  const stale = { code: 'ESTALE' };
  for (const [what, call] of [
    ['acquire', () => view.acquire(view.epoch, g)],
    ['invalidatedSince', () => view.invalidatedSince(view.epoch, g)],
    ['revision', () => view.revision()],
    ['storageKey', () => view.storageKey('f')],
    ['readdir', () => view.readdir('')],
    ['readFile', () => view.readFile('f')],
  ]) assert.throws(call, stale, what);
});

assert.deepEqual(failed, [], 'every case reads as the live tree does, while pinned');
console.log('sqlite-vfs-snapshot-reads: ok');
