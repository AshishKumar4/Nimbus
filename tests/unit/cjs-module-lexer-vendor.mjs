#!/usr/bin/env bun
// cjs-module-lexer.ts vendors cjs-module-lexer's JavaScript build in a
// factory. Between its markers it must hold the pinned package's lexer.js,
// with only its three `module.exports` lines dropped, and the pin must be
// exact and Node 22.22.3's: then updating the package without updating the
// copy fails here, and so does a pin Node does not run.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const corePackage = new URL('../../packages/core/package.json', import.meta.url);
const pinned = JSON.parse(await readFile(corePackage, 'utf8')).dependencies?.['cjs-module-lexer'];
assert.match(pinned, /^\d+\.\d+\.\d+$/, `cjs-module-lexer is pinned to one version, not ${pinned}`);
assert.equal(pinned, '2.2.0', "the pin is Node 22.22.3's own (process.versions.cjs_module_lexer)");

const upstreamPath = createRequire(corePackage).resolve('cjs-module-lexer');
const installed = JSON.parse(await readFile(join(dirname(upstreamPath), 'package.json'), 'utf8'));
assert.equal(installed.version, pinned, 'the installed cjs-module-lexer is the pinned one');

const upstream = await readFile(upstreamPath, 'utf8');
const vendored = await readFile(new URL('../../packages/core/src/runtime/cjs-module-lexer.ts', import.meta.url), 'utf8');
const begin = '// ---- begin upstream cjs-module-lexer/lexer.js ----\n';
const end = '\n// ---- end upstream ----';
const copy = vendored.slice(vendored.indexOf(begin) + begin.length, vendored.indexOf(end));
const exportsLines = 'module.exports.init = () => initPromise;\nmodule.exports.initSync = () => {};\nmodule.exports.parse = parseCJS;';
assert.ok(upstream.includes(exportsLines), 'the upstream file ends with its three module.exports lines');
assert.equal(copy, upstream.replace(exportsLines, '').replace(/\n+$/, ''),
  'cjs-module-lexer.ts holds the pinned lexer.js verbatim, but for its module.exports lines');

console.log(`cjs-module-lexer-vendor OK: cjs-module-lexer.ts is cjs-module-lexer ${pinned}'s lexer.js`);
