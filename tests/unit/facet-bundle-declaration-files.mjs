#!/usr/bin/env bun
// facet-bundle-declaration-files — a TypeScript declaration file staged into
// a facet bundle is data and must reach the facet byte-for-byte.
//
// The bundle's ESM→CJS pass transforms `.ts` cells on their EXTENSION, since
// a TypeScript source is never valid input to `new Function`. `.d.ts` shares
// the extension and none of the reason: nothing executes a declaration file,
// and esbuild's output for one is empty by construction. The program that
// ships declaration files reads them as data — `tsc` loads its own
// `lib/lib.*.d.ts` with `readFileSync`, and every global type it checks
// against comes from those bytes. Running them through esbuild replaced
// `lib.es5.d.ts` (217 KB) with an 811-byte license comment, so every program
// `tsc` compiled inside Nimbus was checked against an empty standard library.
//
// Pinned through the public bundle builder with a stand-in esbuild that marks
// what it touched: declaration cells are untouched, a real `.ts` source next
// to them is still transformed, and the classification helpers agree.

import assert from 'node:assert/strict';
import {
  buildPrefetchBundle,
  bundleTypescriptLoader,
  isBundleModuleCandidate,
  isTypescriptDeclarationFile,
} from '../../packages/worker/src/facets/manager.ts';

class FakeVfs {
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

// ── The helpers classify declaration files as data ──────────────────────
for (const path of [
  'lib/lib.es5.d.ts',
  'lib/lib.dom.d.ts',
  'lib/typescript.d.ts',
  'dist/index.d.mts',
  'dist/index.d.cts',
  'x.d.ts',
]) {
  assert.ok(isTypescriptDeclarationFile(path), `${path} is a declaration file`);
  assert.equal(bundleTypescriptLoader(path), null, `${path} gets no esbuild loader`);
  assert.equal(isBundleModuleCandidate(path), false, `${path} never reaches the transform`);
}
// Sources keep their loader: the rule is the `.d.` infix, not the extension.
for (const [path, loader] of [
  ['src/index.ts', 'ts'],
  ['src/view.tsx', 'tsx'],
  ['src/mod.mts', 'ts'],
  ['src/mod.cts', 'ts'],
  ['src/d.ts', 'ts'],
  ['src/dts.ts', 'ts'],
  ['src/module.d/index.ts', 'ts'],
  ['src/a.d.ts.ts', 'ts'],
]) {
  assert.equal(isTypescriptDeclarationFile(path), false, `${path} is a source`);
  assert.equal(bundleTypescriptLoader(path), loader, `loader for ${path}`);
  assert.ok(isBundleModuleCandidate(path), `${path} reaches the transform`);
}

// ── Through the bundle builder ──────────────────────────────────────────
// A typescript@5-shaped tree: a CommonJS bin, the compiler it requires, and
// the declaration files the compiler reads at runtime. Plus one real `.ts`
// source in the same tree, which the pass must still transform.
const TS = 'home/user/proj/node_modules/typescript';
const LIB_ES5 = [
  '/*! ****',
  'Copyright (c) Microsoft Corporation. All rights reserved.',
  '**** */',
  '/// <reference no-default-lib="true"/>',
  'declare var NaN: number;',
  'interface Array<T> { length: number; [n: number]: T; }',
  'declare var Array: ArrayConstructor;',
].join('\n');
const TYPESCRIPT_DTS = 'export declare namespace ts { const version: string; }\nexport = ts;\n';
const files = {
  'home/user/proj/package.json': JSON.stringify({ name: 'proj', private: true }),
  [`${TS}/package.json`]: JSON.stringify({
    name: 'typescript', version: '5.7.3', main: './lib/typescript.js', bin: { tsc: './bin/tsc' },
  }),
  [`${TS}/bin/tsc`]: '#!/usr/bin/env node\nrequire(\'../lib/tsc.js\')\n',
  [`${TS}/lib/tsc.js`]: 'module.exports = require("./_tsc.js");\n',
  [`${TS}/lib/_tsc.js`]: '"use strict";\nvar fs = require("fs");\nvar lib = fs.readFileSync(__dirname + "/lib.es5.d.ts", "utf8");\n',
  [`${TS}/lib/typescript.js`]: '"use strict";\nmodule.exports = {};\n',
  [`${TS}/lib/lib.es5.d.ts`]: LIB_ES5,
  [`${TS}/lib/typescript.d.ts`]: TYPESCRIPT_DTS,
  [`${TS}/lib/helper.ts`]: 'export const helper: number = 1;\n',
};

const touched = [];
const markingEsbuild = {
  async transform(code, opts) {
    touched.push(opts.loader);
    return { code: `/* transformed:${opts.loader} */\n` };
  },
};

const vfs = new FakeVfs(files);
const state = await buildPrefetchBundle(
  vfs, `${TS}/bin/tsc`, '/home/user/proj', files[`${TS}/bin/tsc`], markingEsbuild,
);

// Both declaration files were staged (the entry-package walk sees them) and
// neither was touched — including the one with `export` statements in it,
// which a content sniff would call ESM.
assert.equal(state.bundle[`${TS}/lib/lib.es5.d.ts`], LIB_ES5, 'lib.es5.d.ts reaches the facet verbatim');
assert.equal(state.bundle[`${TS}/lib/typescript.d.ts`], TYPESCRIPT_DTS, 'typescript.d.ts reaches the facet verbatim');

// The `.ts` source in the same tree still goes through the transform.
assert.equal(state.bundle[`${TS}/lib/helper.ts`], '/* transformed:ts */\n', 'a .ts source is still transformed');
assert.deepEqual(touched, ['ts'], 'esbuild ran once, for the one source; never for a declaration file');

// The CommonJS compiler cells are as staged, so the program can run them.
assert.equal(state.bundle[`${TS}/lib/_tsc.js`], files[`${TS}/lib/_tsc.js`]);
assert.equal(state.bundle[`${TS}/bin/tsc`], files[`${TS}/bin/tsc`]);

console.log('facet-bundle-declaration-files: ok');
