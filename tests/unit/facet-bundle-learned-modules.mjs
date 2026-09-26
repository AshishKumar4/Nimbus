#!/usr/bin/env bun
// A module other sessions missed joins this launch's module map, with the
// modules it imports. The shared read profile (read-profile.ts) is asked with
// the closure the launch built, so the manager can find the packages that
// closure can load; a learned JS module is staged as code, not only as data:
// the loader cannot run a module that is not in the map ("not in this
// launch's module map", nuxt's on-change on the throwaway).
import assert from 'node:assert/strict';
import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import { launchFs } from './lib/launch-fs.mjs';

const APP = 'home/user/app';
const NM = `${APP}/node_modules`;
const LIB = `${NM}/lib`;
const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'app', dependencies: { lib: '1.0.0' } }),
  [`${APP}/index.js`]: 'require("lib");\n',
  [`${LIB}/package.json`]: JSON.stringify({ name: 'lib', version: '1.0.0', main: 'index.js' }),
  // The module is named at run time: no static edge reaches it.
  [`${LIB}/index.js`]: 'const which = process.env.WHICH || "x"; module.exports = require("./dyn/" + which + ".js");\n',
  [`${LIB}/dyn/x.js`]: 'module.exports = require("../helper.js");\n',
  [`${LIB}/helper.js`]: 'module.exports = 42;\n',
};

const build = (learnedFor) => buildPrefetchBundle(
  launchFs(files).fs, `/${APP}/index.js`, `/${APP}`, files[`${APP}/index.js`], undefined, undefined,
  undefined, undefined, undefined, learnedFor,
);

// Nothing learned: the run-time module is not in the map.
const cold = await build(undefined);
assert.ok(cold.bundle[`${LIB}/index.js`] !== undefined, 'the static closure holds lib');
assert.equal(cold.bundle[`${LIB}/dyn/x.js`], undefined, 'no static edge reaches dyn/x.js');

// Learned for lib: the module and what it imports are in the map.
let askedWith = null;
const warm = await build(async (closure) => {
  askedWith = [...closure];
  return [`${LIB}/dyn/x.js`];
});
assert.ok(askedWith !== null && askedWith.includes(`${LIB}/index.js`), 'the profile is asked with the closure the launch built');
assert.ok(warm.bundle[`${LIB}/dyn/x.js`] !== undefined, 'the learned module is in the module map');
assert.ok(warm.bundle[`${LIB}/helper.js`] !== undefined, 'and so is the module it imports');

// A profile that cannot be reached leaves the launch as it was.
const down = await build(async () => { throw new Error('bucket unreachable'); });
assert.equal(down.bundle[`${LIB}/dyn/x.js`], undefined);

console.log('facet-bundle-learned-modules: ok');