#!/usr/bin/env bun
// Guard: the staged chunks.json pack must contain EXACTLY the chunk set
// reachable (statically or dynamically) from the staged index.js + worker.js
// and the chunks themselves. A missing chunk is a runtime module-not-found
// inside the facet; an extra chunk is dead weight fetched into every spawn.
// bundle-opencode.mjs enforces this at staging time; this test enforces it on
// the COMMITTED assets so drift can't land through any other path.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPENCODE_ARTIFACT_VERSION,
  OPENCODE_CHUNKS_PACK,
} from '../../packages/worker/src/opencode-artifact.generated.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetDir = path.resolve(
  here,
  '../../packages/worker/public/_assets/opencode',
  OPENCODE_ARTIFACT_VERSION,
);

if (!OPENCODE_CHUNKS_PACK || !existsSync(path.join(assetDir, 'index.js'))) {
  console.log('opencode-chunks-closure SKIP: staged split artifact absent (no build dist)');
  process.exit(0);
}

const pack = JSON.parse(readFileSync(path.join(assetDir, OPENCODE_CHUNKS_PACK), 'utf8'));
const sources = new Map(Object.entries(pack));
sources.set('index.js', readFileSync(path.join(assetDir, 'index.js'), 'utf8'));
sources.set('worker.js', readFileSync(path.join(assetDir, 'worker.js'), 'utf8'));

const CHUNK_REF_RE = /["']\.\/(chunk-[a-z0-9]+\.js)["']/g;
const reachable = new Set();
const queue = ['index.js', 'worker.js'];
while (queue.length > 0) {
  const src = sources.get(queue.pop());
  if (!src) continue;
  for (const m of src.matchAll(CHUNK_REF_RE)) {
    if (!reachable.has(m[1])) {
      reachable.add(m[1]);
      queue.push(m[1]);
    }
  }
}

const packed = new Set(Object.keys(pack));
const missing = [...reachable].filter((n) => !packed.has(n));
const extra = [...packed].filter((n) => !reachable.has(n));
assert.deepEqual(missing, [], `chunks referenced but not packed: ${missing.join(', ')}`);
assert.deepEqual(extra, [], `chunks packed but unreachable: ${extra.join(', ')}`);
assert.ok(packed.size > 0, 'pack is non-empty');

console.log(
  `opencode-chunks-closure OK: ${packed.size} staged chunks == the exact import closure of index.js + worker.js`,
);
