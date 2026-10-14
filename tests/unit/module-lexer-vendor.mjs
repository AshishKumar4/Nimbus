#!/usr/bin/env bun
// module-lexer.ts vendors es-module-lexer's CSP build in a factory. Between
// its markers it must hold the pinned package's dist/lexer.asm.js, with only
// `export` dropped from `export function parse` and its one "use asm"
// directive dropped (V8 refuses the module as asm.js and says so as a process
// warning), and the pin must be exact: then updating the package without
// updating the copy fails here.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const corePackage = new URL('../../packages/core/package.json', import.meta.url);
const pinned = JSON.parse(await readFile(corePackage, 'utf8')).devDependencies['es-module-lexer'];
assert.match(pinned, /^\d+\.\d+\.\d+$/, `es-module-lexer is pinned to one version, not ${pinned}`);

const upstreamPath = createRequire(corePackage).resolve('es-module-lexer/js');
const installed = JSON.parse(await readFile(join(dirname(dirname(upstreamPath)), 'package.json'), 'utf8'));
assert.equal(installed.version, pinned, 'the installed es-module-lexer is the pinned one');

const upstream = await readFile(upstreamPath, 'utf8');
const vendored = await readFile(new URL('../../packages/core/src/runtime/module-lexer.ts', import.meta.url), 'utf8');
const begin = '// ---- begin upstream es-module-lexer/dist/lexer.asm.js ----\n';
const end = '\n// ---- end upstream ----';
const copy = vendored.slice(vendored.indexOf(begin) + begin.length, vendored.indexOf(end));
assert.equal(upstream.split('"use asm";').length, 2, 'the pinned dist/lexer.asm.js has one "use asm" directive');
assert.equal(copy, upstream.replace('export function parse(', 'function parse(').replace('"use asm";', '').replace(/\n+$/, ''),
  'module-lexer.ts holds the pinned dist/lexer.asm.js verbatim, but for its one export and its asm.js directive');

console.log(`module-lexer-vendor OK: module-lexer.ts is es-module-lexer ${pinned}'s CSP build`);
