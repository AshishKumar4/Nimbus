#!/usr/bin/env bun
// The one-shot map bound has one unit: raw bytes, which is what the session
// DO's memory was measured in (platform/limits.ts), and what the require walk
// counts. The snapshot's guard used JSON-encoded bytes (about 5% more), so a
// closure the walk accepted then shed a 13-byte config.json the program reads
// with readFileSync, which then raised EAGAIN. (Main's P2 on 3d39172c.)
//
// And when the required closure alone is past the bound, the launch fails with
// the named bound error; nothing is evicted to make room.

import assert from 'node:assert/strict';

import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import { ClosureBoundExceededError } from '../../packages/core/src/runtime/require-resolver.ts';
import { VFS_BUNDLE_MAX_BYTES } from '../../packages/core/src/constants.ts';
import { launchFs } from './lib/launch-fs.mjs';

const PROJ = 'home/user/proj';
// Escapes on every line, so the encoded map is well over the raw bytes.
const line = 'x = "a"; y = f(1);\n';
const sized = (bytes) => line.repeat(Math.floor(bytes / line.length));
const project = (bigBytes) => ({
  [`${PROJ}/package.json`]: JSON.stringify({ name: 'proj' }),
  [`${PROJ}/app.js`]: 'require("./big.js");\nrequire("fs").readFileSync(__dirname + "/config.json");\n',
  [`${PROJ}/big.js`]: sized(bigBytes),
  [`${PROJ}/config.json`]: JSON.stringify({ port: 3000 }),
});

// Under the bound in raw bytes, over it encoded.
{
  const files = project(VFS_BUNDLE_MAX_BYTES - 1024 * 1024);
  const state = await buildPrefetchBundle(launchFs(files).fs, { scriptPath: `${PROJ}/app.js`, cwd: PROJ, entryCode: files[`${PROJ}/app.js`] });
  assert.equal(state.truncated, false, 'a snapshot under the bound in raw bytes sheds nothing');
  assert.equal(state.bundle[`${PROJ}/config.json`], files[`${PROJ}/config.json`], 'the config the program reads is staged');
}

// The required closure alone past the bound: the named error, not an eviction.
{
  const files = project(VFS_BUNDLE_MAX_BYTES + 1024 * 1024);
  await assert.rejects(
    buildPrefetchBundle(launchFs(files).fs, { scriptPath: `${PROJ}/app.js`, cwd: PROJ, entryCode: files[`${PROJ}/app.js`] }),
    (error) => error instanceof ClosureBoundExceededError,
    'a closure past the bound fails the launch by name',
  );
}

console.log('facet-snapshot-bound-unit: the bound is raw bytes, the walk\'s and the measurement\'s');
