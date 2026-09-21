#!/usr/bin/env bun
// facet-bundle-typescript-cells — a TypeScript file in a facet bundle reaches
// the facet as the bytes on disk, and runs from a compiled cell beside it.
//
// A bundle cell is two things to the facet: what `readFileSync` returns for
// the path, and what the startup pre-compile loop turns into the function
// `require` runs. For JavaScript those are the same bytes. For a TypeScript
// source they are not, and the ESM→CJS pass used to rewrite the cell in
// place with esbuild's emit. Two things broke, both on `tsc`:
//
//   - `tsc -p .` read its project's `src/index.ts` and got esbuild's
//     CommonJS rendering of it — `__toCommonJS`, `module.exports` — so it
//     compiled that, emitted a file nobody wrote, and reported diagnostics
//     on lines the source never had (`Cannot find name 'module'`).
//   - every `lib/lib.*.d.ts` the compiler checks against was reduced to an
//     811-byte license comment, since esbuild's output for a declaration
//     file is empty by construction.
//
// And the rewrite bought nothing: the facet's pre-compile loop only ever
// compiled `.js`/`.mjs`/`.cjs`/extensionless cells, so a `require('./x.ts')`
// still died at request time with "file was not pre-bundled".
//
// Now the source cell stays verbatim, the emit travels under a compiled-cell
// key no path can collide with, declaration files are never transformed, and
// the shared pre-compile loop both facets run registers the emit under the
// real path and drops the key before any read can see it.

import assert from 'node:assert/strict';
import {
  BUNDLE_PRECOMPILE_LOOP,
  FACET_COMPILE_HELPER,
  buildPrefetchBundle,
  bundleTypescriptLoader,
  compiledCellKey,
  compiledCellPath,
  generateEntrypointCode,
  generateLongRunningNodeCode,
  isBundleModuleCandidate,
  isTypescriptDeclarationFile,
} from '../../packages/worker/src/facets/manager.ts';

class FakeVfs {
  get authority() { return { acquire: async () => ({ epoch: this.epoch, rev: this.revision() }), stat: async path => this.lstat(path) }; }

  epoch = 'fake-vfs-epoch';
  revision() { return 0; }
  constructor(files) {
    this.files = new Map(Object.entries(files));
    this.dirs = new Set();
    for (const file of this.files.keys()) {
      const parts = file.split('/');
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
    }
  }
  exists(p) { const s = p.replace(/^\/+/, ''); return this.files.has(s) || this.dirs.has(s); }
  isDirectory(p) { return this.dirs.has(p.replace(/^\/+/, '')); }
  readFile(p) { return new TextEncoder().encode(this.readFileString(p)); }
  readFileString(p) {
    const s = p.replace(/^\/+/, '');
    const c = this.files.get(s);
    if (c === undefined) throw new Error(`missing file: ${s}`);
    return c;
  }
  readdir(p) {
    const s = p.replace(/^\/+/, '');
    const prefix = s ? `${s}/` : '';
    const entries = new Map();
    for (const d of this.dirs) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      entries.set(rest, 'directory');
    }
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      entries.set(rest, 'file');
    }
    return Array.from(entries, ([name, type]) => ({ name, type }));
  }
  lstat(p) {
    const s = p.replace(/^\/+/, '');
    if (this.dirs.has(s)) return { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 };
    const c = this.files.get(s);
    if (c === undefined) throw new Error(`missing path: ${s}`);
    return { type: 'file', size: c.length, mode: 0o644, uid: 1000, gid: 1000 };
  }
  stat(p) { return this.lstat(p); }
  access(p) { if (!this.exists(p)) throw new Error(`missing path: ${p}`); }
}

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
// The compiled-cell key round-trips and can never be a path: it contains NUL.
assert.equal(compiledCellPath(compiledCellKey('home/user/a.ts')), 'home/user/a.ts');
assert.equal(compiledCellPath('home/user/a.ts'), null);
assert.ok(compiledCellKey('x').includes('\0'));

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

// Stands in for esbuild's CJS emit: strips the type annotation and marks the
// output, so the bundle shows what the pass produced and from what.
const touched = [];
const cjsEsbuild = {
  async transform(code, opts) {
    touched.push(opts.loader);
    assert.equal(opts.format, 'cjs');
    return { code: `/* emit:${opts.loader} */\nexports.greet = function (who) { return "NIMBUS-TSC-EMIT:" + who; };\n` };
  },
};

const vfs = new FakeVfs(files);
const state = await buildPrefetchBundle(
  vfs, `${TS}/bin/tsc`, `/${PROJ}`, files[`${TS}/bin/tsc`], cjsEsbuild,
);
const { bundle } = state;

// The project source is staged as the bytes on disk — what `tsc` reads.
assert.equal(bundle[`${PROJ}/src/index.ts`], INDEX_TS, 'src/index.ts reaches the facet verbatim');
// Its emit rides beside it under the compiled-cell key.
const compiledKey = compiledCellKey(`${PROJ}/src/index.ts`);
assert.ok(typeof bundle[compiledKey] === 'string', 'the compiled cell exists');
assert.match(bundle[compiledKey], /^\/\* emit:ts \*\//, 'the compiled cell is the esbuild emit');
// Declaration files were staged and never transformed — including the one
// with `export` statements, which a content sniff would call ESM.
assert.equal(bundle[`${TS}/lib/lib.es5.d.ts`], LIB_ES5, 'lib.es5.d.ts reaches the facet verbatim');
assert.equal(bundle[`${TS}/lib/typescript.d.ts`], TYPESCRIPT_DTS, 'typescript.d.ts reaches the facet verbatim');
assert.equal(compiledKey in bundle && compiledCellKey(`${TS}/lib/lib.es5.d.ts`) in bundle, false,
  'a declaration file gets no compiled cell');
assert.deepEqual(touched, ['ts'], 'esbuild ran once, for the one source; never for a declaration file');
// The CommonJS compiler cells are as staged.
assert.equal(bundle[`${TS}/lib/_tsc.js`], files[`${TS}/lib/_tsc.js`]);
assert.equal(bundle[`${TS}/bin/tsc`], files[`${TS}/bin/tsc`]);
// Metadata describes paths only; the compiled key is not a file.
assert.equal(compiledKey in state.metadata, false, 'metadata carries no entry for the compiled key');
assert.ok(`${PROJ}/src/index.ts` in state.metadata, 'metadata describes the source');

// ── The facet-side pre-compile loop, exactly as generated ───────────────
// Both generated facets splice the same loop, so one evaluation covers both.
const SHIMS = '/* __SHIMS_MARKER__ */';
const CRED = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const oneShot = (await generateEntrypointCode('', state, false, SHIMS)).code;
const resident = (await generateLongRunningNodeCode('', state, { cred: CRED }, false, SHIMS)).code;
for (const [label, source] of [['one-shot node facet', oneShot], ['long-running node facet', resident]]) {
  assert.ok(source.includes(BUNDLE_PRECOMPILE_LOOP.trim()), `${label}: splices the shared pre-compile loop`);
  assert.ok(source.includes(FACET_COMPILE_HELPER.trim()), `${label}: splices the shared compile helper`);
  assert.equal(source.split('function __mkCompiledFn(').length, 2, `${label}: defines the helper once`);
}

// Run the loop the way the facet does: at module evaluation, over the parsed
// bundle, with the facet's own compile helper. A required module that keeps
// its shebang (pi 0.87.0's cli-runtime.js, loaded through createRequire from
// the bin) must compile like the bin itself does; before the helper was
// shared, only the one-shot facet stripped it.
const facetBundle = {
  ...Object.fromEntries(Object.entries(bundle).filter(([, cell]) => typeof cell === 'string')),
  [`${TS}/LICENSE`]: 'Apache License 2.0\n',
  [`${TS}/lib/runtime.js`]: '#!/usr/bin/env node\nconst require = () => 1;\nmodule.exports = { shebang: "stripped" };\n',
};
const __compiledModules = new Map();
const __compileFailures = new Map();
const __mkCompiledFn = new Function(`${FACET_COMPILE_HELPER}; return __mkCompiledFn;`)();
new Function('__MODULE_VFS_BUNDLE', '__compiledModules', '__compileFailures', '__mkCompiledFn', BUNDLE_PRECOMPILE_LOOP)(
  facetBundle, __compiledModules, __compileFailures, __mkCompiledFn,
);
{
  const runtime = __compiledModules.get(`${TS}/lib/runtime.js`);
  assert.equal(typeof runtime, 'function', `a required module with a shebang compiles: ${__compileFailures.get(`${TS}/lib/runtime.js`)}`);
  const m = { exports: {} };
  runtime(m.exports, () => { throw new Error('no require expected'); }, m, '/x', '/');
  assert.deepEqual(m.exports, { shebang: 'stripped' }, 'and its own `require` declaration wins over the parameter');
}

// The TypeScript source is now runnable under its real path, from the emit.
const compiled = __compiledModules.get(`${PROJ}/src/index.ts`);
assert.equal(typeof compiled, 'function', 'src/index.ts is registered under its own path');
const mod = { exports: {} };
compiled(mod.exports, () => { throw new Error('no require expected'); }, mod, '/x', '/');
assert.equal(mod.exports.greet('ok'), 'NIMBUS-TSC-EMIT:ok', 'and it runs the emit');
// The key is gone from the bundle; the source is still there for readers.
assert.equal(compiledKey in facetBundle, false, 'the compiled key is removed before any read');
assert.equal(facetBundle[`${PROJ}/src/index.ts`], INDEX_TS, 'the source cell is untouched');
// JavaScript cells compile from their own bytes, as before.
assert.equal(typeof __compiledModules.get(`${TS}/lib/_tsc.js`), 'function');
assert.equal(typeof __compiledModules.get(`${TS}/bin/tsc`), 'function', 'an extensionless bin script compiles');
// Declaration files and data are not compiled; a non-JS extensionless file
// records its failure rather than crashing the facet.
assert.equal(__compiledModules.has(`${TS}/lib/lib.es5.d.ts`), false);
assert.equal(__compiledModules.has(`${PROJ}/package.json`), false);
assert.ok(__compileFailures.has(`${TS}/LICENSE`), 'LICENSE is recorded as a compile failure, not thrown');
assert.equal(__compileFailures.has(`${PROJ}/src/index.ts`), false);

console.log('facet-bundle-typescript-cells: ok');
