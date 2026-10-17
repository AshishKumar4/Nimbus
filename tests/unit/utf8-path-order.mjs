#!/usr/bin/env bun
// One string order for paths, compareUtf8 (platform utf8.ts), as their UTF-8
// bytes order them: node's Buffer.compare of each string's UTF-8 is the
// oracle, and SQLite's ORDER BY of a text column (the engine's index) the
// second. Strings mix ASCII, the BMP below and above the surrogates
// (U+E000..U+FFFF), astral code points, and lone surrogates, which UTF-8
// writes as U+FFFD. The names composite.ts and git's dircache.ts export
// (comparePaths) are the same function.
//
// Red before: composite's and git's comparators ordered a lone surrogate
// by its own value, so U+D800 and U+DC00 differed where their bytes (EF BF
// BD, both) are equal, and sorted a lone high surrogate below U+E000.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';

import { compareUtf8 } from '../../packages/platform/src/utf8.ts';
import { comparePaths as compositeOrder } from '../../packages/core/src/vfs/composite.ts';
import { comparePaths as gitOrder } from '../../packages/worker/src/git/worktree/dircache.ts';

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);
const bytesOrder = (a, b) => sign(Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));

const pieces = ['a', 'b', 'z', '/', '~', 'é', 'ÿ', '\u07ff', '\u0800', '\ud7ff', '\ue000', '\uf8ff', '\ufffd', '\uffff', '😀', '\u{10000}', '\u{10ffff}', '\ud800', '\udc00', '\udbff', '\udfff'];
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const strings = ['', ...pieces];
for (let n = 0; n < 1500; n++) {
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
    const want = bytesOrder(a, b);
    assert.equal(sign(compareUtf8(a, b)), want, `compareUtf8(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    pairs++;
  }
}
assert.equal(compositeOrder, compareUtf8, 'composite\'s comparePaths is compareUtf8');
assert.equal(gitOrder, compareUtf8, 'git\'s comparePaths is compareUtf8');
assert.equal(compareUtf8('\ud800', '\udc00'), 0, 'two lone surrogates are one U+FFFD');
assert.ok(compareUtf8('\ud800', '\ue000') > 0, 'a lone surrogate (U+FFFD) after U+E000');

// SQLite's ORDER BY of the same strings, encoded as it stores them (UTF-8, a lone surrogate as U+FFFD).
const db = new Database(':memory:');
db.run('CREATE TABLE t (path TEXT)');
const insert = db.prepare('INSERT INTO t VALUES (?)');
const distinct = [...new Set(strings.map((s) => Buffer.from(s, 'utf8').toString('utf8')))];
for (const text of distinct) insert.run(text);
const sqliteOrder = db.query('SELECT path FROM t ORDER BY path').all().map((row) => row.path);
assert.deepEqual([...distinct].sort(compareUtf8), sqliteOrder, 'compareUtf8 sorts as SQLite\'s ORDER BY');
db.close();

console.log(`utf8-path-order: ok (${pairs} pairs against Buffer, ${distinct.length} strings against SQLite)`);
