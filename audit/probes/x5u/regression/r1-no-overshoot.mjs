#!/usr/bin/env bun
// X.5-U regression probe #1 — helper must NOT pull in unrelated files.
//
// Three negative cases:
//   N1: Dynamic readFileSync — `path.resolve(__dirname, fileName)` with
//       a variable. Helper must skip (literal-only, like Z3).
//   N2: Template-literal interpolation — `path.resolve(__dirname, `${x}.txt`)`.
//       Helper must skip (avoid runtime-resolved bundle bloat).
//   N3: Plain readFileSync without __dirname — e.g. relative path direct.
//       Helper must skip (different shape; not our class).
//   N4: A regular non-dotfile filename without the heuristic words
//       (e.g. "data.txt"). Helper must NOT match — file is not in our
//       narrow class. (Z3 already handles `.txt` via ASSET_EXT, so we'd
//       double-cover; but the new helper is meant to be a NARROWER
//       additive pass for the dotfile/digest class only.)

import { makeVfs, tryRealDotfileHelper, check, summary, reset } from '../_helpers.mjs';

reset();
console.log('X.5-U regression/r1-no-overshoot — helper bounded to literal + dotfile/digest heuristic');

const fixture = {
  'home/user/app/node_modules/dyn/package.json': JSON.stringify({ name: 'dyn', main: 'index.js' }),
  // N1: dynamic specifier
  'home/user/app/node_modules/dyn/index.js':
    'var fs = require("fs");\n' +
    'var path = require("path");\n' +
    'function load(name) { return fs.readFileSync(path.resolve(__dirname, name), "utf8"); }\n' +
    'module.exports = { load };\n',
  // would match if helper were sloppy:
  'home/user/app/node_modules/dyn/.secret-dotfile': 'should-not-be-pulled',

  'home/user/app/node_modules/tpl/package.json': JSON.stringify({ name: 'tpl', main: 'index.js' }),
  // N2: template-literal interpolation
  'home/user/app/node_modules/tpl/index.js':
    'var fs = require("fs");\n' +
    'var path = require("path");\n' +
    'function load(x) { return fs.readFileSync(path.resolve(__dirname, `${x}.txt`), "utf8"); }\n' +
    'module.exports = { load };\n',
  'home/user/app/node_modules/tpl/data.txt': 'should-not-be-pulled',

  'home/user/app/node_modules/plain/package.json': JSON.stringify({ name: 'plain', main: 'index.js' }),
  // N3: no __dirname
  'home/user/app/node_modules/plain/index.js':
    'var fs = require("fs");\n' +
    'module.exports = fs.readFileSync("./relative-thing.txt", "utf8");\n',
  'home/user/app/node_modules/plain/relative-thing.txt': 'should-not-be-pulled',

  'home/user/app/node_modules/regular/package.json': JSON.stringify({ name: 'regular', main: 'index.js' }),
  // N4: literal filename without dotfile/digest/etc heuristic match
  'home/user/app/node_modules/regular/index.js':
    'var fs = require("fs");\n' +
    'var path = require("path");\n' +
    'module.exports = fs.readFileSync(path.resolve(__dirname, "ordinary-file.bin"), "utf8");\n',
  'home/user/app/node_modules/regular/ordinary-file.bin': 'large-binary-blob',

  'home/user/app/script.js': 'require("dyn"); require("tpl"); require("plain"); require("regular");\n',
};

const vfs = makeVfs(fixture);
const cwd = '/home/user/app';

const inputBundle = {};
const sourceKeys = Object.keys(fixture).filter(k =>
  k.endsWith('.js') ||
  k === 'home/user/app/node_modules/dyn/package.json' ||
  k === 'home/user/app/node_modules/tpl/package.json' ||
  k === 'home/user/app/node_modules/plain/package.json' ||
  k === 'home/user/app/node_modules/regular/package.json',
);
for (const k of sourceKeys) inputBundle[k] = fixture[k];

const SHOULD_NOT = [
  'home/user/app/node_modules/dyn/.secret-dotfile',     // dynamic specifier — skip
  'home/user/app/node_modules/tpl/data.txt',             // template interp — skip
  'home/user/app/node_modules/plain/relative-thing.txt', // no __dirname — skip
  'home/user/app/node_modules/regular/ordinary-file.bin',// no heuristic match — skip
];

const helper = await tryRealDotfileHelper();
if (helper === null) {
  console.log('  (TDD-RED) helper not exported — regression check pending');
  check('addStaticReadFileDotfilesAndCompiled exists', false);
  // Pre-fix: the bundle obviously doesn't contain these — no work to do.
  for (const k of SHOULD_NOT) {
    check(`(RED-baseline) ${k} not in bundle`, !(k in inputBundle));
  }
} else {
  const counters = { totalBytes: 0, fileCount: Object.keys(inputBundle).length };
  for (const k of Object.keys(inputBundle)) counters.totalBytes += inputBundle[k].length;
  const before = counters.fileCount;
  helper(vfs, cwd, inputBundle, counters);
  for (const k of SHOULD_NOT) {
    check(`${k} NOT pulled by helper (overshoot guard)`, !(k in inputBundle));
  }
  check(
    'fileCount unchanged (helper added nothing on this synthetic input)',
    counters.fileCount === before,
    `before=${before} after=${counters.fileCount}`,
  );
}

const ok = summary();
process.exit(ok ? 0 : 1);
