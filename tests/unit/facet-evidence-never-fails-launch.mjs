#!/usr/bin/env bun
// Only the require walk's closure can fail a launch against the snapshot
// bound. What the launch stages on evidence (this session's own sync-read
// misses, and read-profile entries other sessions learned) fills only the room
// the closure leaves under the bound: this session's misses first, learned
// entries after. A program that launched once must not start failing on every
// launch because a miss or another session's evidence was learned: that failed
// launch settles nothing, so it would never heal. (Main's P1 on 40b5af60.)

import assert from 'node:assert/strict';

import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import { VFS_BUNDLE_MAX_BYTES } from '../../packages/core/src/constants.ts';
import { launchFs } from './lib/launch-fs.mjs';

const PROJ = 'home/user/proj';
const MiB = 1024 * 1024;
const build = (files, observed, learnedFor) => buildPrefetchBundle(
  launchFs(files).fs, `${PROJ}/app.js`, PROJ, files[`${PROJ}/app.js`],
  undefined, undefined, observed, undefined, undefined, learnedFor,
);

// A 15 MiB closure; the data file an earlier run missed is 4 MiB, past the
// 3 MiB of room the closure leaves.
{
  const data = `${PROJ}/data/model.bin`;
  const files = {
    [`${PROJ}/package.json`]: JSON.stringify({ name: 'proj' }),
    [`${PROJ}/app.js`]: 'require("./big.js");\nconst fs = require("fs"); fs.readFileSync(process.env.DATA);\n',
    [`${PROJ}/big.js`]: '// ' + 'x'.repeat(VFS_BUNDLE_MAX_BYTES - 3 * MiB),
    [data]: 'd'.repeat(4 * MiB),
  };
  const first = await build(files);
  assert.equal(first.bundle[data], undefined);
  const again = await build(files, new Set([data]));
  assert.ok(again.bundle[`${PROJ}/big.js`] !== undefined, 'the closure is staged');
  assert.equal(again.bundle[data], undefined, 'a miss past the room is not staged');
}

// A 16 MiB closure; a read-profile entry of 2.25 MiB, past the 2 MiB of room.
{
  const extra = `${PROJ}/node_modules/big/extra/locale.js`;
  const files = {
    [`${PROJ}/package.json`]: JSON.stringify({ name: 'proj', dependencies: { big: '1.0.0' } }),
    [`${PROJ}/app.js`]: 'require("big");\n',
    [`${PROJ}/node_modules/big/package.json`]: JSON.stringify({ name: 'big', main: 'index.js' }),
    [`${PROJ}/node_modules/big/index.js`]: '// ' + 'x'.repeat(VFS_BUNDLE_MAX_BYTES - 2 * MiB),
    [extra]: '// ' + 'y'.repeat(2 * MiB + 256 * 1024),
  };
  const state = await build(files, undefined, async () => [extra]);
  assert.ok(state.bundle[`${PROJ}/node_modules/big/index.js`] !== undefined, 'the closure is staged');
  assert.equal(state.bundle[extra], undefined, 'a learned entry past the room is not staged');
}

// 3 MiB of room: this session's 2 MiB miss is staged ahead of another
// session's 2 MiB learned entry, which no longer fits.
{
  const own = `${PROJ}/data/own.bin`;
  const theirs = `${PROJ}/data/theirs.bin`;
  const files = {
    [`${PROJ}/package.json`]: JSON.stringify({ name: 'proj' }),
    [`${PROJ}/app.js`]: 'require("./big.js");\n',
    [`${PROJ}/big.js`]: '// ' + 'x'.repeat(VFS_BUNDLE_MAX_BYTES - 3 * MiB),
    [own]: 'o'.repeat(2 * MiB),
    [theirs]: 't'.repeat(2 * MiB),
  };
  const state = await build(files, new Set([own]), async () => [theirs]);
  assert.ok(state.bundle[own] !== undefined, "this session's own miss is staged first");
  assert.equal(state.bundle[theirs], undefined, 'the learned entry gets only the room left');
  const roomy = await build(files, undefined, async () => [theirs]);
  assert.ok(roomy.bundle[theirs] !== undefined, 'a learned entry that fits the room is staged');
}

console.log('facet-evidence-never-fails-launch: evidence fills the room the closure leaves, and never fails a launch');
