#!/usr/bin/env bun
// The staged opencode chunk pack expands, a chunk at a time from its byte
// range (OPENCODE_CHUNK_RANGES), to exactly the sources the pack holds: every
// chunk, each to its own source, none more, and each ASCII. The ranges are of the committed,
// pinned bytes, read through the same fetch a facet's load uses.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPENCODE_ARTIFACT_VERSION,
  OPENCODE_CHUNK_RANGES,
  OPENCODE_CHUNKS_PACK,
} from '../../packages/worker/src/opencode-artifact.generated.ts';
import { fetchOpencodeChunkSources } from '../../packages/worker/src/runtime/opencode-artifact.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetDir = path.resolve(here, '../../packages/worker/public/_assets/opencode', OPENCODE_ARTIFACT_VERSION);

if (!OPENCODE_CHUNKS_PACK || !existsSync(path.join(assetDir, OPENCODE_CHUNKS_PACK))) {
  console.log('opencode-chunk-ranges SKIP: staged split artifact absent (no build dist)');
  process.exit(0);
}
assert.ok(OPENCODE_CHUNK_RANGES, 'a staged pack has its chunk ranges');

const bytes = readFileSync(path.join(assetDir, OPENCODE_CHUNKS_PACK));
const env = {
  ASSETS: {
    async fetch(request) {
      assert.equal(new URL(request.url).pathname.endsWith(`/${OPENCODE_CHUNKS_PACK}`), true);
      return new Response(bytes);
    },
  },
};
const sources = await fetchOpencodeChunkSources(env, OPENCODE_CHUNKS_PACK, OPENCODE_CHUNK_RANGES);
const pack = JSON.parse(bytes.toString('utf8'));
assert.deepEqual(Object.keys(sources).sort(), Object.keys(pack).sort(), 'every chunk, none more');
for (const [name, source] of Object.entries(pack)) assert.equal(sources[name], source, `${name} decodes to its own source`);
// One character above U+00FF makes V8 hold a whole source two-byte, twice its
// size, in the session that assembles the module map and in the facet.
const wide = Object.entries(sources).filter(([, source]) => /[^\x00-\x7f]/.test(source)).map(([name]) => name);
assert.deepEqual(wide, [], `every chunk source is ASCII (${wide.length} are not)`);

console.log(`opencode-chunk-ranges OK: ${Object.keys(sources).length} chunks decoded from their ranges`);
