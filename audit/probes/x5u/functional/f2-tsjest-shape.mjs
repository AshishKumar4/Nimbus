#!/usr/bin/env bun
// X.5-U functional probe #2 — exact ts-jest shape.
//
// Mirrors ts-jest@29.1.4's package/dist/legacy/config/config-set.js:105:
//
//   var fs_1 = require("fs");
//   var path_1 = require("path");
//   exports.MY_DIGEST = (0, fs_1.readFileSync)(
//     (0, path_1.resolve)(__dirname, '../../../.ts-jest-digest'), 'utf8');
//
// Distinct from f1 in that the asset filename starts with `.` AND
// continues with the literal word "ts-jest-digest" (no recognized
// extension). The helper's heuristic must accept this shape: leading
// dot OR matches /digest|hash|version|sha|md5/.

import { makeVfs, tryRealDotfileHelper, check, summary, reset } from '../_helpers.mjs';

reset();

console.log('X.5-U functional/f2-tsjest-shape — exact ts-jest .ts-jest-digest pattern prefetched');

// Mirror ts-jest's directory structure: digest at root, source 3 dirs deep.
const fixture = {
  'home/user/app/node_modules/ts-jest/package.json': JSON.stringify({
    name: 'ts-jest',
    version: '29.1.4',
    main: './dist/legacy/index.js',
  }),
  'home/user/app/node_modules/ts-jest/.ts-jest-digest':
    'bdc3f261ac17efdeccd11ccec4d3ce6c393abe5d',
  'home/user/app/node_modules/ts-jest/dist/legacy/index.js':
    'module.exports = require("./config/config-set.js");\n',
  'home/user/app/node_modules/ts-jest/dist/legacy/config/config-set.js':
    'var fs_1 = require("fs");\n' +
    'var path_1 = require("path");\n' +
    "exports.MY_DIGEST = (0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, '../../../.ts-jest-digest'), 'utf8');\n" +
    'module.exports = exports;\n',
  'home/user/app/script.js':
    'const m = require("ts-jest"); module.exports = m;\n',
};

const vfs = makeVfs(fixture);
const cwd = '/home/user/app';

const inputBundle = {};
const includeKeys = [
  'home/user/app/script.js',
  'home/user/app/node_modules/ts-jest/package.json',
  'home/user/app/node_modules/ts-jest/dist/legacy/index.js',
  'home/user/app/node_modules/ts-jest/dist/legacy/config/config-set.js',
];
for (const k of includeKeys) inputBundle[k] = fixture[k];

const ASSET_KEY = 'home/user/app/node_modules/ts-jest/.ts-jest-digest';

const helper = await tryRealDotfileHelper();

if (helper === null) {
  console.log('  (TDD-RED) addStaticReadFileDotfilesAndCompiled not exported');
  check('addStaticReadFileDotfilesAndCompiled exists', false);
  check('.ts-jest-digest is absent from bundle (RED baseline)', !(ASSET_KEY in inputBundle));
} else {
  const counters = { totalBytes: 0, fileCount: Object.keys(inputBundle).length };
  for (const k of Object.keys(inputBundle)) counters.totalBytes += inputBundle[k].length;
  helper(vfs, cwd, inputBundle, counters);
  check('addStaticReadFileDotfilesAndCompiled exists', true);
  check(
    '.ts-jest-digest is in bundle after the new pass',
    ASSET_KEY in inputBundle,
    'helper resolved 3-up `../../../.ts-jest-digest` correctly',
  );
  check(
    '.ts-jest-digest content is the 40-byte sha1',
    inputBundle[ASSET_KEY] === fixture[ASSET_KEY],
    JSON.stringify(inputBundle[ASSET_KEY]),
  );
}

const ok = summary();
process.exit(ok ? 0 : 1);
