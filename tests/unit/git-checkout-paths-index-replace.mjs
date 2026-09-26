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
const restored = new Set(index.filter((p) => p.startsWith('pkg7/')).slice(0, 1_000));
index.push('pkg7', 'pkg7/dir7');
const started = performance.now();
const replaced = replacedIndexEntries(index, restored);
const ms = performance.now() - started;
assert.deepEqual(replaced, ['pkg7', 'pkg7/dir7']);
assert.ok(ms < 100, `50,000 entries with ${restored.size} restored took ${ms.toFixed(0)} ms`);
console.log(`git-checkout-paths-index-replace: ok (${ms.toFixed(1)} ms for 50,000 entries)`);
