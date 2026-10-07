#!/usr/bin/env bun
// checkout <tree> -- <path> drops the index entries a restored path replaces
// (add_index_entry_with_check): a file at one of its leading directories, or
// anything below it. It costs lookups in the index per restored path, not a
// pass over the index: 50,000 entries with 1,000 restored used to take about
// 2 s when it was index x restored.

import assert from 'node:assert/strict';
import { replacedIndexEntries } from '../../packages/worker/src/git/commands.ts';
import { DirCache, EMPTY_BLOB, NewEntries } from '../../packages/worker/src/git/worktree/dircache.ts';

/** An index holding `paths`, as git would write it. */
const indexOf = (paths) => {
  const added = new NewEntries();
  for (const path of paths) added.add({ path, mode: 0o100644, oid: EMPTY_BLOB, stat: null });
  return DirCache.parse(DirCache.empty().encode({ added }), 0);
};
const replacedPaths = (paths, restored) => {
  const dc = indexOf(paths);
  return [...replacedIndexEntries(dc, restored)].sort((a, b) => a - b).map((i) => dc.path(i));
};

assert.deepEqual(
  replacedPaths(['a', 'd', 'd/x', 'e/f', 'e/f/g', 'k', 'l/m/n'], new Set(['d/x', 'e/f/g', 'l'])),
  ['d', 'e/f', 'l/m/n'],
  'a file at a leading directory of a restored path, and everything below a restored path',
);
assert.deepEqual(replacedPaths(['ab', 'a/b'], new Set(['a'])), ['a/b'], 'a sibling sharing a prefix stays');
assert.deepEqual(replacedPaths(['a'], new Set(['ab/c'])), [], 'so does a file named like part of a directory');

const paths = Array.from({ length: 50_000 }, (_, i) => `pkg${i % 50}/dir${i % 500}/file${i}.js`);
paths.push('pkg7', 'pkg7/dir7');
const dc = indexOf(paths);
// Counted rather than timed: every look at the restored set (a membership
// test, or a step through it) is one operation.
let looks = 0;
class CountedSet extends Set {
  has(value) { looks++; return super.has(value); }
  *[Symbol.iterator]() { for (const value of super.values()) { looks++; yield value; } }
}
const restored = new CountedSet(paths.filter((p) => p.startsWith('pkg7/') && p.split('/').length === 3).slice(0, 1_000));
looks = 0;
const replaced = [...replacedIndexEntries(dc, restored)].map((i) => dc.path(i)).sort();
assert.deepEqual(replaced, ['pkg7', 'pkg7/dir7']);
// Each restored path looks once at itself and once per leading directory the
// index holds as a file: a bound in the restored set alone, whatever the index holds.
const bound = restored.size * 4;
assert.ok(looks <= bound, `50,000 entries with ${restored.size} restored took ${looks} looks at the restored set (at most ${bound})`);
console.log(`git-checkout-paths-index-replace: ok (${looks} looks for 50,000 entries)`);
