#!/usr/bin/env bun
// facet-bundle-typescript-cells — a TypeScript file in a facet bundle reaches
// the facet as the bytes on disk, and runs from its emit as its module cell.
//
// A bundle file is two things to the facet: what `readFileSync` returns for
// the path, and the module cell `require` runs. For JavaScript those are the
// same bytes. For a TypeScript source they are not, and the ESM→CJS pass used
// to rewrite the cell in place with esbuild's emit. Two things broke, both on
// `tsc`:
//
//   - `tsc -p .` read its project's `src/index.ts` and got esbuild's
//     CommonJS rendering of it — `__toCommonJS`, `module.exports` — so it
//     compiled that, emitted a file nobody wrote, and reported diagnostics
//     on lines the source never had (`Cannot find name 'module'`).
//   - every `lib/lib.*.d.ts` the compiler checks against was reduced to an
//     811-byte license comment, since esbuild's output for a declaration
//     file is empty by construction.
//
// Now the source stays verbatim as the file the store holds, the emit is the
// path's `{ cjs }` module (and never also data), declaration files are never
// transformed, and a JavaScript file no transform changed is its own module's
// text (one-shot-module-file-reads covers one that a transform did change).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFacetVfsBundleSource,
  buildPrefetchBundle,
  generateEntrypointCode,
} from '../../packages/worker/src/facets/manager.ts';
import {
  bundleTypescriptLoader,
  isBundleModuleCandidate,
  isTypescriptDeclarationFile,
} from '../../packages/core/src/runtime/bundle-cell-transform.ts';
import { commonJsCellModuleName } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { launchFs } from './lib/launch-fs.mjs';
import { generatedModuleSet, moduleMapBundle, moduleMapCodeCells, writeModuleSet } from './lib/module-map-bundle.mjs';

const dir = mkdtempSync(join(tmpdir(), 'facet-ts-cells-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));


// ── Classification ──────────────────────────────────────────────────────
for (const path of [
  'lib/lib.es5.d.ts', 'lib/lib.dom.d.ts', 'lib/typescript.d.ts', 'dist/index.d.mts', 'dist/index.d.cts', 'x.d.ts',
]) {
  assert.ok(isTypescriptDeclarationFile(path), `${path} is a declaration file`);
  assert.equal(bundleTypescriptLoader(path), null, `${path} gets no esbuild loader`);
  assert.equal(isBundleModuleCandidate(path), false, `${path} never reaches the transform`);
}
// Sources keep their loader: the rule is the `.d.` infix, not the extension.
for (const [path, loader] of [
  ['src/index.ts', 'ts'], ['src/view.tsx', 'tsx'], ['src/mod.mts', 'ts'], ['src/mod.cts', 'ts'],
  ['src/d.ts', 'ts'], ['src/dts.ts', 'ts'], ['src/module.d/index.ts', 'ts'], ['src/a.d.ts.ts', 'ts'],
]) {
  assert.equal(isTypescriptDeclarationFile(path), false, `${path} is a source`);
  assert.equal(bundleTypescriptLoader(path), loader, `loader for ${path}`);
  assert.ok(isBundleModuleCandidate(path), `${path} reaches the transform`);
}

// ── Through the bundle builder ──────────────────────────────────────────
// A typescript@5-shaped tree next to a project: the CommonJS compiler, the
// declaration files it reads at runtime, and the project's own TypeScript
// source — which `tsc` reads as data and which a program could `require`.
const PROJ = 'home/user/proj';
const TS = `${PROJ}/node_modules/typescript`;
const LIB_ES5 = [
  '/*! ****',
  'Copyright (c) Microsoft Corporation. All rights reserved.',
  '**** */',
  '/// <reference no-default-lib="true"/>',
  'declare var NaN: number;',
  'interface Array<T> { length: number; [n: number]: T; }',
].join('\n');
const TYPESCRIPT_DTS = 'export declare namespace ts { const version: string; }\nexport = ts;\n';
const INDEX_TS = 'export function greet(who: string): string {\n  return `NIMBUS-TSC-EMIT:${who}`;\n}\n';
const files = {
  [`${PROJ}/package.json`]: JSON.stringify({ name: 'proj', private: true }),
  [`${PROJ}/tsconfig.json`]: '{}',
  [`${PROJ}/src/index.ts`]: INDEX_TS,
  [`${TS}/package.json`]: JSON.stringify({
    name: 'typescript', version: '5.7.3', main: './lib/typescript.js', bin: { tsc: './bin/tsc' },
  }),
  [`${TS}/bin/tsc`]: '#!/usr/bin/env node\nrequire(\'../lib/tsc.js\')\n',
  [`${TS}/lib/tsc.js`]: 'module.exports = require("./_tsc.js");\n',
  [`${TS}/lib/_tsc.js`]: '"use strict";\nvar fs = require("fs");\nvar lib = fs.readFileSync(__dirname + "/lib.es5.d.ts", "utf8");\n',
  [`${TS}/lib/typescript.js`]: '"use strict";\nmodule.exports = {};\n',
  [`${TS}/lib/lib.es5.d.ts`]: LIB_ES5,
  [`${TS}/lib/typescript.d.ts`]: TYPESCRIPT_DTS,
};

// Stands in for esbuild's CJS emit, as the transform host the session's
// esbuild uses: strips the type annotation and marks the output, so the
// bundle shows what the pass produced and from what.
const touched = [];
const cjsEsbuild = new EsbuildService(undefined, {
  transformHost: async (requests) => requests.map(({ options }) => {
    touched.push(options.loader);
    assert.equal(options.format, 'cjs');
    return {
      code: `/* emit:${options.loader} */\nexports.greet = function (who) { return "NIMBUS-TSC-EMIT:" + who; };\n`,
      map: '',
      warnings: [],
    };
  }),
});

const vfs = launchFs(files).fs;
const state = await buildPrefetchBundle(
  vfs, { scriptPath: `${TS}/bin/tsc`, cwd: `/${PROJ}`, entryCode: files[`${TS}/bin/tsc`], esbuild: cjsEsbuild },
);
const { bundle } = state;

// The project source is staged as the bytes on disk — what `tsc` reads.
assert.equal(bundle[`${PROJ}/src/index.ts`], INDEX_TS, 'src/index.ts reaches the facet verbatim');
// Its emit is kept beside it for the module cell.
assert.match(state.emits?.get(`${PROJ}/src/index.ts`) ?? '', /^\/\* emit:ts \*\//, 'the emit is the esbuild output');
// Declaration files were staged and never transformed — including the one
// with `export` statements, which a content sniff would call ESM.
assert.equal(bundle[`${TS}/lib/lib.es5.d.ts`], LIB_ES5, 'lib.es5.d.ts reaches the facet verbatim');
assert.equal(bundle[`${TS}/lib/typescript.d.ts`], TYPESCRIPT_DTS, 'typescript.d.ts reaches the facet verbatim');
assert.equal(state.emits?.has(`${TS}/lib/lib.es5.d.ts`), false, 'a declaration file gets no emit');
assert.deepEqual(touched, ['ts'], 'esbuild ran once, for the one source; never for a declaration file');
// The CommonJS compiler cells are as staged.
assert.equal(bundle[`${TS}/lib/_tsc.js`], files[`${TS}/lib/_tsc.js`]);
assert.equal(bundle[`${TS}/bin/tsc`], files[`${TS}/bin/tsc`]);

// ── The facet's module map, as a launch generates it ─────────────────────
const SHIMS = '/* __SHIMS_MARKER__ */';
const set = generatedModuleSet(await generateEntrypointCode('', state, false, nodeFacetSources(SHIMS)), 'runner.js');

// What the process's store holds: every file as the program reads it.
const held = moduleMapBundle(set);
assert.equal(held[`${PROJ}/src/index.ts`], INDEX_TS, 'the store holds the TypeScript source, not its emit');
assert.equal(held[`${TS}/lib/lib.es5.d.ts`], LIB_ES5);
assert.equal(held[`${TS}/lib/_tsc.js`], files[`${TS}/lib/_tsc.js`], 'a JavaScript file is read back from its module');
assert.equal(held[`${TS}/bin/tsc`], files[`${TS}/bin/tsc`], 'a shebang survives the read-back');

// What the program runs: a module per code file, the emit for the source.
const cells = new Map(moduleMapCodeCells(set).map((row) => [row[0], row]));
assert.equal(cells.get(`${PROJ}/src/index.ts`)?.[5], 0, 'the emit is not adopted as the file');
assert.equal(cells.has(`${TS}/lib/lib.es5.d.ts`), false, 'a declaration file is no module');
assert.equal(cells.has(`${PROJ}/package.json`), false, 'data is no module');
const main = writeModuleSet(join(dir, 'one-shot'), set, 'runner.js');
const requireCell = globalThis.__nimbusTestCreateRequire(new URL(`file://${main}`).href);
const call = (key, require = () => { throw new Error('no require expected'); }) => {
  const mod = { exports: {} };
  requireCell('./' + commonJsCellModuleName(key))(Function)(mod.exports, require, mod, '/x', '/');
  return mod.exports;
};
assert.equal(call(`${PROJ}/src/index.ts`).greet('ok'), 'NIMBUS-TSC-EMIT:ok', 'the source runs its emit, under its own path');
assert.deepEqual(call(`${TS}/lib/tsc.js`, (id) => `required:${id}`), 'required:./_tsc.js', 'a JavaScript cell runs its own bytes');

// A required module lowered from ESM that keeps its shebang and declares its
// own `require` (pi 0.87.0's cli-runtime.js, loaded through createRequire
// from the bin) runs; a CommonJS module with a var and a function of one name
// runs, as Node runs it; a non-JavaScript extensionless file is a module
// nothing compiles until something requires it, and still reads as the file
// it is.
const extra = await buildFacetVfsBundleSource({
  [`${TS}/lib/runtime.js`]: '#!/usr/bin/env node\nconst require = () => 1;\nmodule.exports = { shebang: "stripped" };\n',
  [`${TS}/lib/legacy.js`]: 'var helper = 1;\nfunction helper() {}\nmodule.exports = typeof helper;\n',
  [`${TS}/LICENSE`]: 'Apache License 2.0\n',
}, false, undefined, { lowered: new Set([`${TS}/lib/runtime.js`]) });
const extraSet = { 'runner.js': `const __NIMBUS_CODE_CELLS = ${extra.codeCells};\nconst __MODULE_VFS_BUNDLE = __nimbusWithCodeCells(${extra.expression});\n` };
for (const [name, text] of Object.entries(extra.codeModules)) extraSet[name] = { cjs: text };
const extraMain = writeModuleSet(join(dir, 'extra'), extraSet, 'runner.js');
const extraRequire = globalThis.__nimbusTestCreateRequire(new URL(`file://${extraMain}`).href);
{
  const m = { exports: {} };
  extraRequire('./' + commonJsCellModuleName(`${TS}/lib/runtime.js`))(Function)(m.exports, () => { throw new Error('the wrapper require'); }, m, '/x', '/');
  assert.deepEqual(m.exports, { shebang: 'stripped' }, 'the module\'s own `require` declaration wins over the parameter');
  const legacy = { exports: {} };
  extraRequire('./' + commonJsCellModuleName(`${TS}/lib/legacy.js`))(Function)(legacy.exports, () => {}, legacy, '/x', '/');
  assert.equal(legacy.exports, 'number', 'a CommonJS var and function of one name compile, as in Node');
}
assert.equal(moduleMapBundle(extraSet)[`${TS}/LICENSE`], 'Apache License 2.0\n', 'LICENSE reads back as the file it is');

console.log('facet-bundle-typescript-cells: ok');
