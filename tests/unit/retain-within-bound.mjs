#!/usr/bin/env bun
// The size guard's eviction (manager.ts retainWithinBound) keeps exactly what
// the loop it replaced kept: that loop rebuilt the retained set from every
// kept group after each eviction (quadratic, and paced each time). Random
// snapshots: independent paths, overlapping groups, evictable orders that mix
// independent paths, group roots and paths that are neither; the retained set
// and the final bytes must match, and the pacing must not grow with the
// evictions times the groups.

import assert from 'node:assert/strict';

import { retainWithinBound } from '../../packages/worker/src/facets/manager.ts';

/** The loop as it was (manager.ts before retainWithinBound). */
async function reference(bound, rawTotal, independent, keptGroups, evictable, rawBytes, pacer) {
  async function retainedPaths() {
    const retained = new Set(independent);
    for (const group of keptGroups) {
      let work = 0;
      for (const path of group.members) { retained.add(path); work += path.length + 256; }
      if (pacer) await pacer.spend(work);
    }
    return retained;
  }
  let retained = await retainedPaths();
  for (const path of evictable) {
    if (rawTotal <= bound) break;
    if (independent.delete(path)) {
      for (const group of keptGroups) if (group.members.has(path)) keptGroups.delete(group);
    } else {
      for (const group of keptGroups) if (group.root === path) keptGroups.delete(group);
    }
    retained = await retainedPaths();
    rawTotal = 0;
    for (const path of retained) rawTotal += rawBytes.get(path) ?? 0;
  }
  return { retained, rawTotal };
}

let seed = 12345;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (list) => list[Math.floor(random() * list.length)];

let cases = 0;
let evictedCases = 0;
let spentNew = 0;
let spentOld = 0;
for (let round = 0; round < 400; round++) {
  const paths = Array.from({ length: 5 + Math.floor(random() * 60) }, (_, i) => `node_modules/p${i % 7}/f${i}.js`);
  const rawBytes = new Map(paths.map((path) => [path, 1 + Math.floor(random() * 5000)]));
  if (random() < 0.3) rawBytes.set('not/in/bundle.js', 777);
  const groups = Array.from({ length: Math.floor(random() * 8) }, () => {
    const members = new Set(Array.from({ length: 1 + Math.floor(random() * 10) }, () => pick(paths)));
    return { root: [...members][0], members };
  });
  const members = new Set(groups.flatMap((group) => [...group.members]));
  const independent = paths.filter((path) => !members.has(path) || random() < 0.2);
  const evictable = Array.from({ length: Math.floor(random() * paths.length) }, () => (random() < 0.1 ? 'neither.js' : pick(paths)));
  const total = [...rawBytes.values()].reduce((a, b) => a + b, 0);
  const bound = Math.floor(total * random());
  const run = async (fn) => {
    let spent = 0;
    const pacer = { async spend(bytes) { spent += bytes; } };
    const result = await fn(bound, total, new Set(independent), new Set(groups), evictable, rawBytes, pacer);
    return { ...result, spent };
  };
  const want = await run(reference);
  const seen = await run(retainWithinBound);
  assert.deepEqual([...seen.retained].sort(), [...want.retained].sort(), `round ${round}: the same paths kept`);
  assert.equal(seen.rawTotal, want.rawTotal, `round ${round}: the same bytes left`);
  spentNew += seen.spent;
  spentOld += want.spent;
  cases++;
  if (want.retained.size < new Set([...independent, ...members]).size) evictedCases++;
}
assert.ok(evictedCases > 50, `the rounds evict (${evictedCases} of ${cases})`);
assert.ok(spentNew < spentOld, `pacing no longer repeats per eviction (${spentNew} against ${spentOld})`);
console.log(`retain-within-bound: ${cases} snapshots kept as before (${evictedCases} evicting); paced ${spentNew} against ${spentOld}`);
