#!/usr/bin/env bun
// One string order for paths, compareUtf8 (platform utf8.ts): by UTF-8
// bytes, and a string UTF-8 cannot write (a lone surrogate) by its WTF-8
// bytes, which write that surrogate as a code point of its own. Oracles:
//   - node's Buffer.compare of UTF-8, for every pair of well-formed strings;
//   - a WTF-8 encoder (below, by its definition), for every pair;
//   - SQLite's ORDER BY of a text column, for the well-formed ones.
// Strings mix ASCII, the BMP below and above the surrogates, astral code
// points, the halves of one pair, and lone surrogates. The order is total
// (two strings, compared either way, the reverse), and decided at the
// first code point that differs, so in a sorted list a directory's entries
// follow it together: a mounted namespace's listing and fs-list-tree's
// subtree walks rely on that, and a mounted backend's names are its own
// strings. A long run of surrogates is compared without recursing. The
// names composite.ts and git's dircache.ts export (comparePaths) are the
// same function.
//
// Red before: composite's and git's comparators sorted a lone high
// surrogate above U+E000, where WTF-8 writes it below; the engine's took
// two different lone surrogates as one string.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';

import { compareUtf8 } from '../../packages/platform/src/utf8.ts';
import { comparePaths as compositeOrder } from '../../packages/core/src/vfs/composite.ts';
import { comparePaths as gitOrder } from '../../packages/worker/src/git/worktree/dircache.ts';

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);
const wellFormed = (text) => text.isWellFormed();

/** WTF-8: each code point (a lone surrogate one of its own) as UTF-8 writes a scalar value. */
function wtf8(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00); i++; }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Buffer.from(out);
}

// Halves of one pair among them, so a pair can differ only in its low half, or meet a lone half.
const pieces = ['a', 'b', 'z', '/', '~', 'é', 'ÿ', '\u07ff', '\u0800', '\ud7ff', '\ue000', '\uf8ff', '\ufffd', '\uffff', '😀', '😁', '\u{10000}', '\u{10ffff}', '\ud800', '\udc00', '\udbff', '\udfff', '\ud83d', '\ude00'];
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const strings = ['', ...pieces];
for (let n = 0; n < 3000; n++) {
  let text = '';
  const length = 1 + Math.floor(random() * 6);
  for (let k = 0; k < length; k++) text += pieces[Math.floor(random() * pieces.length)];
  strings.push(text);
}

let pairs = 0;
for (let i = 0; i < strings.length; i += 3) {
  for (let j = 0; j < strings.length; j += 7) {
    const a = strings[i];
    const b = strings[j];
    const got = sign(compareUtf8(a, b));
    const label = `compareUtf8(${JSON.stringify(a)}, ${JSON.stringify(b)})`;
    assert.equal(got, sign(Buffer.compare(wtf8(a), wtf8(b))), `${label}: WTF-8`);
    if (wellFormed(a) && wellFormed(b)) assert.equal(got, sign(Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))), `${label}: UTF-8`);
    assert.equal(sign(compareUtf8(b, a)), sign(-got), `${label}: and the reverse`);
    assert.equal(got === 0, a === b, `${label}: zero for one string alone`);
    pairs++;
  }
}
assert.equal(compositeOrder, compareUtf8, 'composite\'s comparePaths is compareUtf8');
assert.equal(gitOrder, compareUtf8, 'git\'s comparePaths is compareUtf8');
assert.ok(compareUtf8('\ud800', '\ue000') < 0 && compareUtf8('\ud7ff', '\ud800') < 0, 'a lone surrogate between U+D7FF and U+E000');
const long = 100_000;
assert.equal(sign(compareUtf8('\udc00'.repeat(long), '\udfff'.repeat(long))), -1, 'a long run of surrogates, without recursing');

// A directory's entries follow it together, its name a lone surrogate or not.
const dirs = ['\ud800', '\udc00', '\udbff', 'a', '\ue000', '😀', '\ud83d'];
const tree = [];
for (const dir of dirs) {
  tree.push('/' + dir);
  for (const leaf of ['a', 'z', '\ud800', '\udfff', '😀']) tree.push(`/${dir}/${leaf}`);
}
tree.sort(compareUtf8);
for (const dir of dirs) {
  const at = tree.map((path, index) => (path.startsWith(`/${dir}/`) ? index : -1)).filter((index) => index >= 0);
  assert.deepEqual(at, at.map((_, k) => at[0] + k), `${JSON.stringify(dir)}'s entries follow one another: ${JSON.stringify(tree)}`);
  assert.equal(tree[at[0] - 1], '/' + dir, `${JSON.stringify(dir)}'s entries follow it`);
}

// SQLite's ORDER BY of the well-formed strings.
const db = new Database(':memory:');
db.run('CREATE TABLE t (path TEXT)');
const insert = db.prepare('INSERT INTO t VALUES (?)');
const stored = [...new Set(strings.filter(wellFormed))];
for (const text of stored) insert.run(text);
const sqliteOrder = db.query('SELECT path FROM t ORDER BY path').all().map((row) => row.path);
assert.deepEqual([...stored].sort(compareUtf8), sqliteOrder, 'compareUtf8 sorts as SQLite\'s ORDER BY');
db.close();

// A mounted backend's own names, listed a page at a time: none passed over.
{
  const { CompositeVFS } = await import('../../packages/core/src/vfs/composite.ts');
  const { MemoryVFS } = await import('../../packages/core/src/vfs/memory.ts');
  const owner = { uid: 1000, gid: 1000 };
  const root = new CompositeVFS(new MemoryVFS(owner));
  const mounted = new MemoryVFS(owner);
  const names = ['\ud800', '\udc00', '\udbff', 'a', '\ue000'];
  for (const name of names) mounted.writeFile('/' + name, new TextEncoder().encode(name));
  root.mkdir('/m');
  root.mount('/m', mounted);
  const walked = await root.feed.walk(['/m'], 100);
  const listed = [];
  for (let after = null; ;) {
    const page = root.feed.list(after, 2, walked);
    listed.push(...page.entries.map((entry) => entry.path));
    if (page.next === null) break;
    after = page.next;
  }
  for (const name of names) assert.ok(listed.includes('/m/' + name), `${JSON.stringify(name)} is listed: ${JSON.stringify(listed)}`);
}

console.log(`utf8-path-order: ok (${pairs} pairs against WTF-8 and Buffer, ${stored.length} strings against SQLite)`);
