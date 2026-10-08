#!/usr/bin/env bun
/**
 * commit-graph-reference — the reference a commit-graph writer is held to
 * (lib/commit-graph-reference.mjs) holds what it promises:
 *
 *   - the fixture's graph, as host git writes it, has every chunk a writer
 *     must get right: OIDF, OIDL, CDAT, GDA2, GDO2 (an offset past 2^31),
 *     EDGE (an octopus), BIDX and BDAT (changed paths, version 2);
 *   - one commit's filter is the "too large" one (more than 512 paths);
 *   - writing it again gives the same bytes, and the diff says so (null);
 *   - a byte changed in a chunk is named: the chunk, and the commit.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixture, diffGraphs, parseGraph, referenceGraph } from './lib/commit-graph-reference.mjs';

const root = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'commit-graph-fixture-'));
try {
  const repo = buildFixture(path.join(root, 'repo'));
  const graph = referenceGraph(repo);
  const parsed = parseGraph(graph);
  assert.deepEqual(parsed.table.filter((id) => id !== '\0\0\0\0').sort(),
    ['BDAT', 'BIDX', 'CDAT', 'EDGE', 'GDA2', 'GDO2', 'OIDF', 'OIDL'], 'every chunk a writer must get right');
  const bdat = parsed.chunks.get('BDAT');
  const bdatView = new DataView(bdat.buffer, bdat.byteOffset, bdat.byteLength);
  assert.deepEqual([bdatView.getUint32(0), bdatView.getUint32(4), bdatView.getUint32(8)], [2, 7, 10], 'changed paths version 2, 7 hashes, 10 bits per entry');
  // A "too large" filter is one byte, all ones.
  const bidx = parsed.chunks.get('BIDX');
  const bidxView = new DataView(bidx.buffer, bidx.byteOffset, bidx.byteLength);
  let tooLarge = 0;
  for (let i = 0, start = 12; i < bidx.byteLength / 4; i++) {
    const end = bidxView.getUint32(i * 4) + 12;
    if (end - start === 1 && bdat[start] === 0xff) tooLarge++;
    start = end;
  }
  assert.equal(tooLarge, 1, 'the commit of six hundred files has the "too large" filter');

  assert.equal(diffGraphs(graph, referenceGraph(repo)), null, 'host git writes the same bytes again');
  const changed = graph.slice();
  const cdat = parsed.table.indexOf('CDAT');
  const view = new DataView(graph.buffer, graph.byteOffset, graph.byteLength);
  const cdatAt = Number(view.getBigUint64(8 + cdat * 12 + 4));
  changed[cdatAt + 36 * 3 + 2] ^= 1;
  assert.match(diffGraphs(graph, changed), /^chunk CDAT, commit 3 of \d+/, 'a changed byte is named by chunk and commit');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('commit-graph-reference: ok');
