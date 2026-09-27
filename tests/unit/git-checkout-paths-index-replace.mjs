#!/usr/bin/env bun
// checkout <tree> -- <path> drops the index entries a restored path replaces
// (add_index_entry_with_check): a file at one of its leading directories, or
// anything below it. It is linear in the index, not index x restored: 50,000
// entries with 1,000 restored used to take about 2 s.

import assert from 'node:assert/strict';
import { replacedIndexEntries } from '../../packages/worker/src/git/commands.ts';

assert.deepEqual(
  replacedIndexEntries(['a', 'd', 'd/x', 'e/f', 'e/f/g', 'k', 'l/m/n'], new Set(['d/x', 'e/f/g', 'l'])),
  ['d', 'e/f', 'l/m/n'],
  'a file at a leading directory of a restored path, and everything below a restored path',
);
assert.deepEqual(replacedIndexEntries(['ab', 'a/b'], new Set(['a'])), ['a/b'], 'a sibling sharing a prefix stays');
assert.deepEqual(replacedIndexEntries(['a'], new Set(['ab/c'])), [], 'so does a file named like part of a directory');

const index = Array.from({ length: 50_000 }, (_, i) => `pkg${i % 50}/dir${i % 500}/file${i}.js`);
index.push('pkg7', 'pkg7/dir7');
// Linear, counted rather than timed: every look at the restored set (a
// membership test, or a step through it) is one operation.
let looks = 0;
class CountedSet extends Set {
  has(value) { looks++; return super.has(value); }
  *[Symbol.iterator]() { for (const value of super.values()) { looks++; yield value; } }
}
const restored = new CountedSet(index.filter((p) => p.startsWith('pkg7/')).slice(0, 1_000));
looks = 0;
const replaced = replacedIndexEntries(index, restored);
assert.deepEqual(replaced, ['pkg7', 'pkg7/dir7']);
// Each entry is tested once per leading directory and once whole (at most 3
// here), and the restored set is walked once: index x restored would be 5e7.
const bound = index.length * 3 + restored.size;
assert.ok(looks <= bound, `50,000 entries with ${restored.size} restored took ${looks} looks at the restored set (linear is at most ${bound})`);
console.log(`git-checkout-paths-index-replace: ok (${looks} looks for 50,000 entries)`);
