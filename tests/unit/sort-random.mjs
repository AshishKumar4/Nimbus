#!/usr/bin/env bun
// sort -R without --random-source: a random order that keeps equal keys
// together, and a different one from run to run. sort accepted -R and
// sorted as if it had not been given; the orders a --random-source fixes are
// GNU's own (tests/fixtures/gnu/sort.json).
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  const lines = ['k', 'c', 'k', 'a', 'j', 'c', 'b', 'i', 'k', 'h', 'g', 'f', 'e', 'd'];
  await ws.fs.writeFile('/tmp/in', `${lines.join('\n')}\n`);
  const orders = new Set();
  for (let run = 0; run < 12; run++) {
    const r = await ws.exec('sort -R /tmp/in');
    assert.equal(r.exitCode, 0, r.stderr);
    const out = r.stdout.trimEnd().split('\n');
    assert.deepEqual([...out].sort(), [...lines].sort(), 'a permutation of the input');
    for (const key of ['k', 'c']) {
      const at = out.indexOf(key);
      assert.ok(out.slice(at, at + lines.filter((l) => l === key).length).every((l) => l === key), `the ${key}s are together`);
    }
    orders.add(out.join(' '));
  }
  assert.ok(orders.size > 1, 'each run draws its own order');
} finally {
  await ws.close();
}
console.log('sort-random: ok');
