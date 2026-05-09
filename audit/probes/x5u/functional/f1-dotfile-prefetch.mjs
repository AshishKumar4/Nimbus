#!/usr/bin/env bun
// X.5-U functional probe — synthetic SWC-compiled package whose entry
// reads a `.cache-file` dotfile via `(0, fs_1.readFileSync)((0,
// path_1.resolve)(__dirname, "<rel>"))` (TS/SWC `(0, x.y)(args)` shape).
//
// The dotfile is on the synthetic VFS but the existing
// addStaticReadFileAssets helper does NOT match the SWC-shape regex
// AND its ASSET_EXT excludes dotfiles. Phase D's new helper
// `addStaticReadFileDotfilesAndCompiled` should pull `.cache-file` into
// `bundle` so the runtime fs shim's readFileSync can serve it.
//
// PRE-FIX: TDD-RED.  helper not exported → probe asserts the absence.
// POST-FIX: GREEN.  helper exists, pulls the dotfile, content matches.

import { makeVfs, tryRealDotfileHelper, check, summary, reset } from '../_helpers.mjs';

reset();

console.log('X.5-U functional/f1-dotfile-prefetch — SWC-shaped readFileSync(__dirname, "<dotfile>") prefetched');

const fixture = {
  // Pkg meta
  'home/user/app/node_modules/synth-swc/package.json': JSON.stringify({
    name: 'synth-swc',
    version: '0.0.0',
    main: './dist/index.js',
  }),
  // SWC-compiled entry: the canonical TS-output (0, x.y)(args) shape AND
  // a leading-dot filename. Mirrors ts-jest's
  //   exports.MY_DIGEST = (0, fs_1.readFileSync)(
  //     (0, path_1.resolve)(__dirname, '../.cache-file'), 'utf8');
  'home/user/app/node_modules/synth-swc/dist/index.js':
    'var fs_1 = require("fs");\n' +
    'var path_1 = require("path");\n' +
    'exports.DIGEST = (0, fs_1.readFileSync)(\n' +
    '  (0, path_1.resolve)(__dirname, "../.cache-file"),\n' +
    '  "utf8",\n' +
    ');\n' +
    'module.exports = exports;\n',
  // The dotfile asset.
  'home/user/app/node_modules/synth-swc/.cache-file':
    'cafef00d-cafef00d-cafef00d-cafef00d-aaaa\n',
  'home/user/app/script.js':
    'const m = require("synth-swc"); module.exports = m;\n',
};

const vfs = makeVfs(fixture);
const cwd = '/home/user/app';

// Build the "after greedyAddMainEntries+prefetchForRequire" snapshot:
// we have entry + pkg.json + main, but no dotfile.
const inputBundle = {};
const includeKeys = [
  'home/user/app/script.js',
  'home/user/app/node_modules/synth-swc/package.json',
  'home/user/app/node_modules/synth-swc/dist/index.js',
];
for (const k of includeKeys) inputBundle[k] = fixture[k];

const ASSET_KEY = 'home/user/app/node_modules/synth-swc/.cache-file';

const helper = await tryRealDotfileHelper();

if (helper === null) {
  console.log('  (TDD-RED) addStaticReadFileDotfilesAndCompiled not exported');
  check(
    'addStaticReadFileDotfilesAndCompiled exists',
    false,
    'expected named export from src/facet-manager.ts (Phase D)',
  );
  // RED-state confirmation: dotfile is NOT in the bundle.
  check(
    'dotfile is absent from bundle (RED baseline confirmation)',
    !(ASSET_KEY in inputBundle),
    'sanity: pre-fix bundle should not contain the dotfile',
  );
} else {
  // GREEN path
  const counters = { totalBytes: 0, fileCount: Object.keys(inputBundle).length };
  for (const k of Object.keys(inputBundle)) counters.totalBytes += inputBundle[k].length;
  const before = counters.fileCount;
  const r = helper(vfs, cwd, inputBundle, counters);
  check('addStaticReadFileDotfilesAndCompiled exists', true);
  check(
    'dotfile is in bundle after the new pass',
    ASSET_KEY in inputBundle,
    'helper pulled .cache-file from VFS into the bundle',
  );
  check(
    'dotfile content matches VFS source',
    inputBundle[ASSET_KEY] === fixture[ASSET_KEY],
    JSON.stringify(inputBundle[ASSET_KEY]),
  );
  check(
    'fileCount counter incremented',
    counters.fileCount === before + 1,
    `fileCount=${counters.fileCount}, expected ${before + 1}`,
  );
  check(
    'helper return shape includes added count',
    r && typeof r.added === 'number' && r.added >= 1,
    JSON.stringify(r),
  );
}

const ok = summary();
process.exit(ok ? 0 : 1);
