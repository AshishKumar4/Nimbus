#!/usr/bin/env bun
// X.5-U regression probe #3 — X.5-Z3's addStaticReadFileAssets must
// remain a callable export with its existing behaviour. The new helper
// is a sibling, not a replacement.
//
// Replays X.5-Z3's f1 case (jsdom-shape .css prefetch) directly against
// the current src/facet-manager.ts.

import { makeVfs, tryRealAssetHelper, check, summary, reset } from '../_helpers.mjs';

reset();
console.log('X.5-U regression/r3-z3-untouched — addStaticReadFileAssets still works as in X.5-Z3');

const fixture = {
  'home/user/app/node_modules/jsdom-mini/package.json': JSON.stringify({
    name: 'jsdom-mini', version: '0.0.0', main: './lib/index.js',
  }),
  'home/user/app/node_modules/jsdom-mini/lib/index.js':
    'const fs = require("fs");\nconst path = require("path");\n' +
    'const defaultStyleSheet = fs.readFileSync(\n' +
    '  path.resolve(__dirname, "../assets/default-stylesheet.css"),\n' +
    '  { encoding: "utf-8" },\n' +
    ');\nmodule.exports = { defaultStyleSheet };\n',
  'home/user/app/node_modules/jsdom-mini/assets/default-stylesheet.css':
    'html, body { margin: 0; padding: 0; }\n',
  'home/user/app/script.js': 'const m = require("jsdom-mini"); module.exports = m;\n',
};

const vfs = makeVfs(fixture);
const cwd = '/home/user/app';
const ASSET_KEY = 'home/user/app/node_modules/jsdom-mini/assets/default-stylesheet.css';

const helper = await tryRealAssetHelper();
if (helper === null) {
  check('addStaticReadFileAssets still exported', false);
} else {
  const inputBundle = {
    'home/user/app/script.js': fixture['home/user/app/script.js'],
    'home/user/app/node_modules/jsdom-mini/package.json': fixture['home/user/app/node_modules/jsdom-mini/package.json'],
    'home/user/app/node_modules/jsdom-mini/lib/index.js': fixture['home/user/app/node_modules/jsdom-mini/lib/index.js'],
  };
  const counters = { totalBytes: 0, fileCount: 3 };
  for (const k of Object.keys(inputBundle)) counters.totalBytes += inputBundle[k].length;
  helper(vfs, cwd, inputBundle, counters);
  check('addStaticReadFileAssets still exported', true);
  check('Z3 jsdom .css still pulled into bundle', ASSET_KEY in inputBundle);
  check(
    'Z3 .css content matches VFS',
    inputBundle[ASSET_KEY] === fixture[ASSET_KEY],
  );
}

const ok = summary();
process.exit(ok ? 0 : 1);
