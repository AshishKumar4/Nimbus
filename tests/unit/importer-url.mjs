#!/usr/bin/env bun
// A module's importer URL is Node's pathToFileURL of its path (audit SHI-6,
// _shared/importer-url.ts): every printable ASCII character, controls, DEL,
// non-ASCII, astral and lone surrogates, `#` and `?` in a name. Host Node is
// the oracle (Bun's pathToFileURL escapes differently, so it is not asked).
// The interpreter and the host share the one encoder.
//
// Red before: the path was concatenated unescaped, so a#b/main.cjs's URL
// ended at its `#`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { importerUrl } from '../../packages/core/src/_shared/importer-url.ts';
import { moduleImporterUrl } from '../../packages/core/src/_shared/module-importer.ts';

let ascii = '';
for (let code = 0x20; code < 0x7f; code++) if (code !== 0x2f) ascii += String.fromCharCode(code);
const PATHS = [
  'home/user/main.mjs',
  'home/user/a#b/main.cjs',
  'home/user/q?x/y.mjs',
  `home/user/${ascii}`,
  'home/user/\u0001\t\n\r\u007f.js',
  'home/user/café/ñ.mjs',
  'home/user/😀/\uD800/\uDFFF/x\uD800y.js',
  'home/user/space name/100%.js',
];
const node = spawnSync('node', ['-e', `const { pathToFileURL } = require('node:url'); console.log(JSON.stringify(${JSON.stringify(PATHS)}.map((p) => pathToFileURL('/' + p).href)));`], { encoding: 'utf8' });
assert.equal(node.status, 0, node.stderr);
const expected = JSON.parse(node.stdout);
const codeAt = (text, index) => text.charCodeAt(index);
assert.deepEqual(PATHS.map((path) => importerUrl(path, codeAt)), expected, "importerUrl is Node's pathToFileURL");
assert.deepEqual(PATHS.map((path) => moduleImporterUrl(`/${path}`)), expected, 'with its leading slash too');
assert.equal(moduleImporterUrl('data:text/javascript,1'), 'data:text/javascript,', 'a data: module imports from data:');
console.log('ok - importer-url (a module path\'s importer URL is Node\'s pathToFileURL of it)');
