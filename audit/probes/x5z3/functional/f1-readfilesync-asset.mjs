// X.5-Z3 functional probe — fs.readFileSync(path.resolve(__dirname, "x.css"))
// pulls the .css asset into the bundle (jsdom shape).
//
// Mirrors jsdom's lib/jsdom/living/css/helpers/computed-style.js:16-19:
//
//   const fs = require("node:fs");
//   const path = require("node:path");
//   const defaultStyleSheet = fs.readFileSync(
//     path.resolve(__dirname, "../../../browser/default-stylesheet.css"),
//     { encoding: "utf-8" },
//   );
//
// Pre-fix: RED. The .css asset is on VFS-disk + manifest but absent
//          from `bundle`; runtime fs.readFileSync ENOENTs.
// Post-fix: GREEN. Phase D's `addStaticReadFileAssets(bundle, vfs)`
//          scans the bundle's JS sources for the static-asset
//          readFileSync pattern and pre-fetches matched files.

import { makeVfs, tryRealAssetHelper, check, summary, reset } from '../_helpers.mjs';

reset();

console.log('X.5-Z3 functional/f1-readfilesync-asset — static .css path.resolve(__dirname,...) gets prefetched');

const fixture = {
  // Pkg meta
  'home/user/app/node_modules/jsdom-mini/package.json': JSON.stringify({
    name: 'jsdom-mini',
    version: '0.0.0',
    main: './lib/index.js',
  }),
  // Source file with the canonical jsdom-shape readFileSync.
  // The pattern: fs.readFileSync(path.resolve(__dirname, "<rel>"), <opts>)
  'home/user/app/node_modules/jsdom-mini/lib/index.js':
    'const fs = require("fs");\n' +
    'const path = require("path");\n' +
    'const defaultStyleSheet = fs.readFileSync(\n' +
    '  path.resolve(__dirname, "../assets/default-stylesheet.css"),\n' +
    '  { encoding: "utf-8" },\n' +
    ');\n' +
    'module.exports = { defaultStyleSheet };\n',
  // The .css asset that the source above reads.
  'home/user/app/node_modules/jsdom-mini/assets/default-stylesheet.css':
    'html, body { margin: 0; padding: 0; }\n',
  // User entry that requires the pkg.
  'home/user/app/script.js':
    'const m = require("jsdom-mini");\nmodule.exports = m;\n',
};

const vfs = makeVfs(fixture);
const cwd = '/home/user/app';

// Construct the input bundle the way greedyAddMainEntries+prefetchForRequire
// would: include script.js, the pkg.json, and the lib/index.js (no .css yet).
const inputBundle = {};
const includeKeys = [
  'home/user/app/script.js',
  'home/user/app/node_modules/jsdom-mini/package.json',
  'home/user/app/node_modules/jsdom-mini/lib/index.js',
];
for (const k of includeKeys) inputBundle[k] = fixture[k];

const helper = await tryRealAssetHelper();
const ASSET_KEY = 'home/user/app/node_modules/jsdom-mini/assets/default-stylesheet.css';

if (helper === null) {
  // TDD-RED state — the helper hasn't been added yet.
  console.log('  (TDD-RED) addStaticReadFileAssets is not exported from facet-manager.ts');
  check(
    'addStaticReadFileAssets exists',
    false,
    'expected named export from src/facet-manager.ts (added in Phase D)',
  );
  check(
    'asset.css would be in bundle after the new pass',
    ASSET_KEY in inputBundle,
    'pre-fix: asset is NOT in bundle (RED — confirms gap)',
  );
} else {
  // POST-FIX state — call the real helper.
  const counters = { totalBytes: 0, fileCount: Object.keys(inputBundle).length };
  for (const k of Object.keys(inputBundle)) counters.totalBytes += inputBundle[k].length;
  helper(vfs, cwd, inputBundle, counters);
  check(
    'addStaticReadFileAssets exists',
    true,
  );
  check(
    'asset.css is in bundle after the new pass',
    ASSET_KEY in inputBundle,
    'GREEN: helper pulled the .css from VFS into the bundle',
  );
  check(
    '.css content matches VFS source',
    inputBundle[ASSET_KEY] === fixture[ASSET_KEY],
    inputBundle[ASSET_KEY],
  );
  check(
    'fileCount counter incremented',
    counters.fileCount === includeKeys.length + 1,
    `fileCount=${counters.fileCount}, expected ${includeKeys.length + 1}`,
  );
}

const ok = summary();
process.exit(ok ? 0 : 1);
