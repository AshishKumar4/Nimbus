#!/usr/bin/env bun
/**
 * git-commit-graph-write — the graph a clone writes (git/pack/commit-graph.ts)
 * is host git's, byte for byte: on the reference fixture
 * (lib/commit-graph-reference.mjs: two roots, merges, an octopus for EDGE, a
 * commit dated 2^31 seconds past its parent for GDO2, a date past 2^32 for
 * CDAT's high bits), the commits recorded from their objects as a clone's
 * commits piece records them, in pack order, against `git commit-graph write
 * --reachable` (generation data v2, no changed-path filters); and git takes
 * it as a chain of one layer: `git commit-graph verify` passes and `git log`
 * reads through it.
 *
 * The commit parser is git's: a date git reads as 0 (no committer line, a
 * name with no '>', a non-numeric date) is 0 here, a negative one wraps.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildFixture, diffGraphs, referenceGraph } from './lib/commit-graph-reference.mjs';
import { bloomFilter, changedPaths, commitRecord, graphCommits, graphName, murmur3, writeCommitGraph } from '../../packages/worker/src/git/pack/commit-graph.ts';

const root = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'commit-graph-write-'));
const git = (cwd, args, input) => execFileSync('git', args, {
  cwd, input, maxBuffer: 1 << 28,
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
});
const hexBytes = (hex) => Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));

/** Every `kind` object of `repo`: its id and bytes, in pack order (as a commits piece meets them). */
function objectsOf(repo, kind = 'commit') {
  const listed = git(repo, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)', '--unordered']).toString().trim().split('\n');
  const ids = listed.map((line) => line.split(' ')).filter(([, type]) => type === kind).map(([id]) => id);
  const batch = git(repo, ['cat-file', '--batch'], ids.join('\n') + '\n');
  const objects = [];
  let at = 0;
  for (const id of ids) {
    const header = batch.subarray(at, batch.indexOf(0x0a, at)).toString();
    const size = Number(header.split(' ')[2]);
    const start = batch.indexOf(0x0a, at) + 1;
    objects.push({ oid: hexBytes(id), data: new Uint8Array(batch.subarray(start, start + size)) });
    at = start + size + 1;
  }
  return objects;
}

try {
  const repo = buildFixture(path.join(root, 'repo'));
  const objects = objectsOf(repo);
  const graph = writeCommitGraph(graphCommits(objects.map(({ oid, data }) => commitRecord(oid, data))));
  const reference = referenceGraph(repo, { changedPaths: false });
  assert.equal(diffGraphs(reference, graph), null, 'the graph is host git\'s, byte for byte');
  console.log(`  ok  ${objects.length} commits: host git's graph, byte for byte (${graph.byteLength} bytes)`);

  // The same commits recorded in another order give the same graph.
  const reversed = writeCommitGraph(graphCommits(objects.reverse().map(({ oid, data }) => commitRecord(oid, data))));
  assert.equal(diffGraphs(reference, reversed), null, 'the record order does not matter');

  // Installed as a chain of one layer, git verifies it and reads through it.
  const name = graphName(graph);
  const dir = path.join(repo, '.git/objects/info/commit-graphs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `graph-${name}.graph`), graph);
  writeFileSync(path.join(dir, 'commit-graph-chain'), name + '\n');
  git(repo, ['commit-graph', 'verify']);
  const logged = git(repo, ['-c', 'core.commitGraph=true', 'log', '--oneline', '--all']).toString().trim().split('\n');
  assert.equal(logged.length, objects.length);
  console.log('  ok  git commit-graph verify passes on the chain; git log reads through it');

  // Changed-path filters, from each commit's first-parent diff of its trees:
  // host git's --changed-paths graph (version 2), byte for byte, the
  // "too large" filter of the six-hundred-file commit included.
  const trees = new Map(objectsOf(repo, 'tree').map(({ oid, data }) => [Buffer.from(oid).toString('hex'), data]));
  const read = async (oid) => {
    const tree = trees.get(Buffer.from(oid).toString('hex'));
    if (tree === undefined) throw new Error('no tree ' + Buffer.from(oid).toString('hex'));
    return tree;
  };
  const commits = graphCommits(objects.map(({ oid, data }) => commitRecord(oid, data)));
  const treeOf = (c) => commits.trees.subarray(c * 20, (c + 1) * 20);
  const filters = [];
  for (let c = 0; c < commits.count; c++) {
    const first = commits.parentStart[c] < commits.parentStart[c + 1] ? commits.parents[commits.parentStart[c]] : -1;
    filters.push(bloomFilter(await changedPaths(read, first < 0 ? null : treeOf(first), treeOf(c))));
  }
  const filtered = writeCommitGraph(commits, filters);
  assert.equal(diffGraphs(referenceGraph(repo), filtered), null, 'with changed-path filters, host git\'s graph, byte for byte');
  console.log(`  ok  changed-path filters for ${commits.count} commits: host git's --changed-paths graph, byte for byte`);

  // murmur3 v2 on bytes past 0x7f (v1's signed-char bug), and the paths' prefixes.
  assert.equal(murmur3(0, new Uint8Array(0)), 0);
  assert.equal(murmur3(0x293ae76f, new TextEncoder().encode('\u00e9t\u00e9')), murmur3(0x293ae76f, Uint8Array.of(0xc3, 0xa9, 0x74, 0xc3, 0xa9)));
  assert.equal(bloomFilter([]).byteLength, 1, 'no changes: one zero byte');
  assert.deepEqual([...bloomFilter(null)], [0xff], 'too many: one 0xff byte');
  assert.equal(bloomFilter([new TextEncoder().encode('a/b/c')]).byteLength, 4, 'a/b/c, a/b and a: 30 bits');

  // git's parse_commit_date, at its edges.
  const oid = new Uint8Array(20);
  const tree = 'tree ' + 'ab'.repeat(20) + '\n';
  const dateOf = (text) => new DataView(commitRecord(oid, new TextEncoder().encode(text)).buffer).getBigUint64(40);
  assert.equal(dateOf(tree + 'author A <a> 5 +0000\ncommitter C <c> 1700000000 +0000\n\nm\n'), 1700000000n);
  assert.equal(dateOf(tree + 'committer C <c> 1700000000 +0000\n\nm\n'), 0n, 'no author line first: 0');
  assert.equal(dateOf(tree + 'author A <a> 5 +0000\ncommitter C c 1700000000 +0000\n\nm\n'), 0n, 'no ">": 0');
  assert.equal(dateOf(tree + 'author A <a> 5 +0000\ncommitter C <c> soon +0000\n\nm\n'), 0n, 'not a number: 0');
  assert.equal(dateOf(tree + 'author A <a> 5 +0000\ncommitter C <c> 123456+0100\n\nm\n'), 123456n, 'digits up to the first non-digit');
  assert.equal(dateOf(tree + 'author A <a> 5 +0000\ncommitter C <c> -1 +0000\n\nm\n'), (1n << 64n) - 1n, 'a negative date wraps, as strtoumax does');
  assert.equal(dateOf(tree + 'author A <a> 5 +0000\ncommitter C <c> 99999999999999999999999 +0000\n\nm\n'), (1n << 64n) - 1n, 'past 2^64: saturated');
  assert.throws(() => commitRecord(oid, new TextEncoder().encode('tree xyz\n')), /bogus commit object/);
  assert.throws(() => graphCommits([commitRecord(hexBytes('01'.repeat(20)), new TextEncoder().encode(tree + 'parent ' + 'cd'.repeat(20) + '\nauthor A <a> 5 +0000\n'))]), /missing parent/);
  console.log('  ok  commit dates as git parses them; a bogus commit and a missing parent refused');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('git-commit-graph-write: ok');
