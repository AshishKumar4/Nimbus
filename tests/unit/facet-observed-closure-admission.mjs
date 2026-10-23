#!/usr/bin/env bun
// A module an earlier run read (addObservedReads) is staged with what it
// loads synchronously, its closure whole or not at all: a part of a closure
// is no use, since the module it leaves out fails its synchronous read. The
// file itself was read, so it stays, as data, either way
// (observed-read-closure.mjs); executed without its closure, the run fails
// naming what it missed (facet-observed-residency.mjs).
//
// The closure walk takes what the map already holds in the representation it
// reads: a cell staged as bytes (a file that is not valid UTF-8,
// _readBundleCell) is the same file as the text a read of it answers, so a
// module that loads one is not declined for it.

import assert from 'node:assert/strict';
import { addObservedReads } from '../../packages/worker/src/facets/manager.ts';
import { launchFs } from './lib/launch-fs.mjs';

const APP = 'home/user/app';
const encoder = new TextEncoder();
const failures = [];
const section = async (name, body) => {
  try { await body(); console.log(`  ${name}`); }
  catch (error) { failures.push(`${name}: ${error.message}`); }
};

await section('a read module whose closure does not fit stays as data, with none of its closure', async () => {
  const root = `${APP}/root.js`;
  const files = {
    [root]: "require('./small.js');\nrequire('./big.js');\n",
    [`${APP}/small.js`]: 'module.exports = 1;\n',
    [`${APP}/big.js`]: `module.exports = "${'x'.repeat(5000)}";\n`,
  };
  const bundle = {};
  const required = new Set();
  const budget = { totalBytes: 0, fileCount: 0 };
  const rootBytes = Buffer.byteLength(files[root]);
  const result = await addObservedReads(launchFs(files).fs, new Set([root]), bundle, required, budget, rootBytes + 100);
  assert.equal(bundle[root], files[root], 'the file the run read is staged');
  assert.ok(required.has(root));
  assert.equal(bundle[`${APP}/small.js`], undefined, 'and no part of a closure that does not fit');
  assert.equal(bundle[`${APP}/big.js`], undefined);
  assert.deepEqual(result, { added: 1, bytes: rootBytes });
});

await section('a read module loading a cell the map holds as bytes is staged with it', async () => {
  const root = `${APP}/root.js`;
  const dep = `${APP}/latin1.js`;
  const depBytes = new Uint8Array([...encoder.encode('module.exports = 1; // caf'), 0xe9, ...encoder.encode('\n')]);
  const files = { [root]: "require('./latin1.js');\n", [dep]: depBytes };
  const bundle = { [dep]: depBytes };
  const required = new Set();
  await addObservedReads(launchFs(files).fs, new Set([root]), bundle, required, { totalBytes: depBytes.byteLength, fileCount: 1 });
  assert.equal(bundle[root], files[root], 'the root is staged');
  assert.ok(required.has(root) && required.has(dep), 'with the cell it loads, required');
  assert.equal(bundle[dep], depBytes, 'which keeps its bytes');
});

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('facet-observed-closure-admission: OK');
