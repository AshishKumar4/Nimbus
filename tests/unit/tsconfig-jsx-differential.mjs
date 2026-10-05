#!/usr/bin/env bun
// esbuild's JSX options and tsconfigRaw, through EsbuildService's transform()
// (Oxc, the staged wasm) and build() (rolldown), against esbuild-wasm 0.24.2,
// Nimbus 0.14.0's engine, on the same calls. Compared on what the output
// does: the imports it emits and what running it makes, each module run
// against recording stubs of the JSX runtimes (an element is the call that
// made it: which function of which module, with what), plus esbuild's
// warnings about the tsconfig. Every case that compiles must also run and
// record what its source makes (EXPECT), on both engines: two outputs that
// fail alike are no pass. Apart from them: the fields the engines cannot
// honour, refused by name only where esbuild's output would differ from
// theirs (runtime/tsconfig-raw.ts), and the calls esbuild fails too.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EsbuildService, buildWithEsbuild } from '../../packages/core/src/runtime/esbuild-service.ts';
import { buildWithRolldown } from '../../packages/core/src/runtime/rolldown-build.ts';
import { esbuildEngine, stopEsbuildEngine } from './lib/esbuild-engine.mjs';
import { oxcEngine } from './lib/oxc-engine.mjs';

const esbuild = await esbuildEngine();
assert.equal(esbuild.version, '0.24.2');
const fromWorker = createRequire(new URL('../../packages/worker/package.json', import.meta.url));
// What the build facet's runtime hands the adapter (scripts/rolldown-facet/entry.mjs).
const rolldown = {
  rolldown: (await import(fromWorker.resolve('rolldown'))).rolldown,
  transformSync: (await import(fromWorker.resolve('rolldown/experimental'))).transformSync,
};

const tc = (compilerOptions) => JSON.stringify({ compilerOptions });

// ── Sources ─────────────────────────────────────────────────────────────

// Every JSX shape a runtime sees differently: attributes, a key before a
// spread and one after it (where the automatic runtime falls back to
// createElement), mapped children with keys, a fragment, a single child; and JSX in a
// method, a function and an arrow, where the development runtime's \`self\` is
// what \`this\` is there. The imports serve the classic runtimes; TypeScript
// drops the ones a mode leaves unused.
const JSX_SOURCE = `import React from 'react';
import { h, Frag } from 'jsx-lib';
const p = { title: 't' };
export const el = <div id="a"><span key="k" {...p} />{[1, 2].map((n) => <i key={n}>{n}</i>)}<>frag</></div>;
export const one = <b>1</b>;
export const spreadKey = <span {...p} key="k" />;
class View { name = 'view'; render() { return <p>{this.name}</p>; } }
export const method = new View().render();
export const fn = (function () { return <q />; }).call({ name: 'receiver' });
export const arrow = (() => <s />)();
`;
const SOURCES = {
  jsx: JSX_SOURCE,
  // Which imports TypeScript keeps: an unused value import, type-only ones, a default and a namespace.
  imports: `import { used, unusedValue } from './a';
import type { T } from './t';
import { type U, V } from './u';
import def from './d';
import * as ns from './ns';
export const x: T | U = used;
`,
  // Strict mode, as the module's code sees it.
  strict: 'export const strict = (function () { return this === undefined; })();\n',
  // Define or assign: a field defined over an inherited setter does not call it.
  fields: `const log: string[] = [];
class Base { set x(v: number) { log.push('set x'); } }
export class C extends Base { x = 1; static s = 2; }
new C();
export { log };
`,
  noFields: 'export class C { #p = 1; declare z: number; m() { return this.#p; } static { (this as any).t = 2; } }\nexport const made = new C().m();\n',
  decorators: 'function dec(t: any) { return t; }\n@dec export class A { m() { return 1; } }\nexport const made = typeof A;\n',
  noDecorators: '/** @param x a value */\nexport class A { m(x: number) { return x; } }\nexport const made = new A().m(1);\n',
  paths: "import { helper } from '@lib/helper';\nexport const got = typeof helper;\n",
  // What each elision keeps: an import whose specifiers are all types, an
  // empty clause, a default beside a type, an unused value, a bare import.
  keep: `import { type T } from './side';
import type { U } from './u2';
import { V } from './v';
import {} from './e';
import d, { type W } from './dw';
import './bare';
export const x: T | U | W | 1 = 1;
`,
};

// What a case that compiles must have done, on both engines: run, and made
// what its source makes (for JSX, every element a recorded call).
const ran = (o) => Boolean(o.runs?.exports) && !o.runs.throws;
const EXPECT = {
  jsx: (o) => o.runs?.preservedJsx === true
    || (ran(o) && ['el', 'one', 'spreadKey', 'method', 'fn', 'arrow'].every((k) => typeof o.runs.exports[k]?.call === 'string')),
  imports: (o) => ran(o) && o.runs.exports.x === 'a',
  keep: (o) => ran(o) && o.runs.exports.x === 1,
  strict: (o) => ran(o) && typeof o.runs.exports.strict === 'boolean',
  fields: (o) => ran(o) && Array.isArray(o.runs.exports.log),
  noFields: (o) => ran(o) && o.runs.exports.made === 1,
  decorators: (o) => ran(o) && o.runs.exports.made === 'function',
  noDecorators: (o) => ran(o) && o.runs.exports.made === 1,
  paths: (o) => ran(o) && o.runs.exports.got === 'function',
};

// ── Cases ───────────────────────────────────────────────────────────────

// Every JSX setting esbuild 0.24.2 honours, from its options and from
// tsconfigRaw, and their precedence (the tsconfig's JSX settings apply over
// the options, except that nothing undoes `jsx: 'preserve'`).
const JSX_CASES = {
  'default': {},
  'jsx automatic': { jsx: 'automatic' },
  'jsx automatic, jsxImportSource': { jsx: 'automatic', jsxImportSource: 'preact' },
  'jsx automatic, jsxDev': { jsx: 'automatic', jsxDev: true },
  'jsx automatic, jsxDev, jsxImportSource': { jsx: 'automatic', jsxDev: true, jsxImportSource: 'preact' },
  'jsx automatic, jsxFactory (classic only)': { jsx: 'automatic', jsxFactory: 'h' },
  'jsxFactory, jsxFragment': { jsxFactory: 'h', jsxFragment: 'Frag' },
  'jsxImportSource alone (automatic only)': { jsxImportSource: 'preact' },
  'jsxDev alone (automatic only)': { jsxDev: true },
  'jsx preserve': { jsx: 'preserve' },
  'tsconfig react': { tsconfigRaw: tc({ jsx: 'react' }) },
  'tsconfig react-jsx': { tsconfigRaw: tc({ jsx: 'react-jsx' }) },
  'tsconfig react-jsxdev': { tsconfigRaw: tc({ jsx: 'react-jsxdev' }) },
  'tsconfig REACT-JSX (any case)': { tsconfigRaw: tc({ jsx: 'REACT-JSX' }) },
  'tsconfig preserve (ignored)': { tsconfigRaw: tc({ jsx: 'preserve' }) },
  'tsconfig react-native (ignored)': { tsconfigRaw: tc({ jsx: 'react-native' }) },
  'tsconfig unknown jsx (ignored)': { tsconfigRaw: tc({ jsx: 'bogus' }) },
  'tsconfig jsxFactory, jsxFragmentFactory': { tsconfigRaw: tc({ jsxFactory: 'h', jsxFragmentFactory: 'Frag' }) },
  'tsconfig react, jsxFactory': { tsconfigRaw: tc({ jsx: 'react', jsxFactory: 'h' }) },
  'tsconfig react-jsx, jsxImportSource': { tsconfigRaw: tc({ jsx: 'react-jsx', jsxImportSource: 'preact' }) },
  'tsconfig react-jsxdev, jsxImportSource': { tsconfigRaw: tc({ jsx: 'react-jsxdev', jsxImportSource: 'preact' }) },
  'tsconfig jsxImportSource alone (automatic only)': { tsconfigRaw: tc({ jsxImportSource: 'preact' }) },
  'tsconfig react-jsx, jsxFactory (classic only)': { tsconfigRaw: tc({ jsx: 'react-jsx', jsxFactory: 'h' }) },
  'tsconfig invalid jsxFactory (warned, ignored)': { tsconfigRaw: tc({ jsxFactory: '1+2' }) },
  'tsconfig jsx outside compilerOptions (warned, ignored)': { tsconfigRaw: JSON.stringify({ jsx: 'react-jsx' }) },
  'tsconfig as an object': { tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } } },
  'tsconfig with comments and trailing commas': { tsconfigRaw: '{\n  // c\n  "compilerOptions": { /* x */ "jsx": "react-jsx", },\n}' },
  'tsconfig // comment ended by a CR': { tsconfigRaw: '{"compilerOptions": { // c\r"jsx": "react-jsx"}}' },
  'tsconfig // comment ended by U+2028': { tsconfigRaw: '{"compilerOptions": { // c\u2028"jsx": "react-jsx"}}' },
  // esbuild's own jsxFragment may be a constant (validateJSXExpr); a factory may not.
  'jsxFragment 0': { jsxFragment: '0' },
  'jsxFragment "frag"': { jsxFragment: '"frag"' },
  "jsxFragment 'f'": { jsxFragment: "'f'" },
  'jsxFragment null': { jsxFragment: 'null' },
  'jsxFragment true': { jsxFragment: 'true' },
  'jsxFragment -1': { jsxFragment: '-1' },
  'jsxFragment undefined (a name)': { jsxFragment: 'undefined' },
  'jsxFragment "frag", jsxFactory h': { jsxFactory: 'h', jsxFragment: '"frag"' },
  'jsxFragment "frag", tsconfig jsxFragmentFactory': { jsxFragment: '"frag"', tsconfigRaw: tc({ jsxFragmentFactory: 'Frag' }) },
  'jsxFragment "frag", jsx automatic (classic only)': { jsx: 'automatic', jsxFragment: '"frag"' },
  "Kinu's tsconfig": { tsconfigRaw: tc({ jsx: 'react-jsx', jsxImportSource: 'react' }) },
  "Vite's react-ts tsconfig": {
    tsconfigRaw: tc({
      target: 'ES2020', useDefineForClassFields: true, lib: ['ES2020', 'DOM'], module: 'ESNext', skipLibCheck: true,
      moduleResolution: 'bundler', allowImportingTsExtensions: true, isolatedModules: true, moduleDetection: 'force',
      noEmit: true, jsx: 'react-jsx', strict: true, noUnusedLocals: true, noUnusedParameters: true,
    }),
  },
  // Precedence.
  'jsx automatic, tsconfig react': { jsx: 'automatic', tsconfigRaw: tc({ jsx: 'react' }) },
  'jsx preserve, tsconfig react-jsx': { jsx: 'preserve', tsconfigRaw: tc({ jsx: 'react-jsx' }) },
  'jsx transform, tsconfig react-jsx': { jsx: 'transform', tsconfigRaw: tc({ jsx: 'react-jsx' }) },
  'jsxFactory, tsconfig jsxFactory': { jsxFactory: 'React.createElement', tsconfigRaw: tc({ jsxFactory: 'h' }) },
  'jsxFragment, tsconfig jsxFragmentFactory': { jsxFactory: 'h', jsxFragment: 'React.Fragment', tsconfigRaw: tc({ jsxFragmentFactory: 'Frag' }) },
  'jsxFactory, tsconfig invalid jsxFactory': { jsxFactory: 'h', tsconfigRaw: tc({ jsxFactory: '1+2' }) },
  'jsxImportSource, tsconfig react-jsx, jsxImportSource': { jsx: 'automatic', jsxImportSource: 'react', tsconfigRaw: tc({ jsx: 'react-jsx', jsxImportSource: 'preact' }) },
  'jsxImportSource, tsconfig react-jsx': { jsxImportSource: 'preact', tsconfigRaw: tc({ jsx: 'react-jsx' }) },
  'jsxDev, tsconfig react-jsx': { jsx: 'automatic', jsxDev: true, tsconfigRaw: tc({ jsx: 'react-jsx' }) },
  'jsxDev, tsconfig react': { jsx: 'automatic', jsxDev: true, tsconfigRaw: tc({ jsx: 'react' }) },
  'jsxDev false, tsconfig react-jsxdev': { jsxDev: false, tsconfigRaw: tc({ jsx: 'react-jsxdev' }) },
};

// The other compilerOptions esbuild reads, each on a source that shows its
// effect. `refused` names the field a refusal must carry; everything else
// must do what esbuild does.
const FIELD_CASES = {
  'verbatimModuleSyntax true': { source: 'imports', options: { tsconfigRaw: tc({ verbatimModuleSyntax: true }) } },
  'verbatimModuleSyntax false': { source: 'imports', options: { tsconfigRaw: tc({ verbatimModuleSyntax: false }) } },
  'preserveValueImports true': { source: 'imports', options: { tsconfigRaw: tc({ preserveValueImports: true }) } },
  'importsNotUsedAsValues remove': { source: 'imports', options: { tsconfigRaw: tc({ importsNotUsedAsValues: 'remove' }) } },
  'importsNotUsedAsValues unknown (warned, ignored)': { source: 'imports', options: { tsconfigRaw: tc({ importsNotUsedAsValues: 'bogus' }) } },
  'importsNotUsedAsValues preserve': { source: 'imports', options: { tsconfigRaw: tc({ importsNotUsedAsValues: 'preserve' }) } },
  'importsNotUsedAsValues error': { source: 'imports', options: { tsconfigRaw: tc({ importsNotUsedAsValues: 'error' }) } },
  // esbuild's KeepValues and KeepStmt apart, on imports whose specifiers are all types.
  'keep: no flags': { source: 'keep', options: {} },
  'keep: preserveValueImports (KeepValues)': { source: 'keep', options: { tsconfigRaw: tc({ preserveValueImports: true }) } },
  'keep: importsNotUsedAsValues preserve (KeepStmt)': { source: 'keep', options: { tsconfigRaw: tc({ importsNotUsedAsValues: 'preserve' }) } },
  'keep: importsNotUsedAsValues error (KeepStmt)': { source: 'keep', options: { tsconfigRaw: tc({ importsNotUsedAsValues: 'error' }) } },
  'keep: verbatimModuleSyntax (both)': { source: 'keep', options: { tsconfigRaw: tc({ verbatimModuleSyntax: true }) } },
  'keep: preserveValueImports and importsNotUsedAsValues preserve (both)': {
    source: 'keep', options: { tsconfigRaw: tc({ preserveValueImports: true, importsNotUsedAsValues: 'preserve' }) },
  },
  'keep: verbatimModuleSyntax false, preserveValueImports': { source: 'keep', options: { tsconfigRaw: tc({ verbatimModuleSyntax: false, preserveValueImports: true }) } },
  'keep: JavaScript (no elision)': { source: 'keep', loader: 'js', options: { tsconfigRaw: tc({ preserveValueImports: true }) } },
  // `extends` that names no file: nothing to read.
  'extends []': { source: 'strict', options: { tsconfigRaw: JSON.stringify({ extends: [] }) } },
  'extends null': { source: 'strict', options: { tsconfigRaw: JSON.stringify({ extends: null }) } },
  'extends 5': { source: 'strict', options: { tsconfigRaw: JSON.stringify({ extends: 5 }) } },
  'alwaysStrict true, JavaScript': { source: 'strict', loader: 'js', options: { tsconfigRaw: tc({ alwaysStrict: true }) } },
  'alwaysStrict true': { source: 'strict', options: { tsconfigRaw: tc({ alwaysStrict: true }) } },
  'alwaysStrict false': { source: 'strict', options: { tsconfigRaw: tc({ alwaysStrict: false }) } },
  'strict true': { source: 'strict', options: { tsconfigRaw: tc({ strict: true }) } },
  'strict true, alwaysStrict false': { source: 'strict', options: { tsconfigRaw: tc({ strict: true, alwaysStrict: false }) } },
  'useDefineForClassFields true': { source: 'fields', options: { tsconfigRaw: tc({ useDefineForClassFields: true }) } },
  'useDefineForClassFields false, no public fields': { source: 'noFields', options: { tsconfigRaw: tc({ useDefineForClassFields: false }) } },
  'useDefineForClassFields false, JavaScript': { source: 'fields', loader: 'js', options: { tsconfigRaw: tc({ useDefineForClassFields: false }) } },
  'target es2022': { source: 'fields', options: { tsconfigRaw: tc({ target: 'es2022' }) } },
  'target ESNext': { source: 'fields', options: { tsconfigRaw: tc({ target: 'ESNext' }) } },
  'target unknown (warned, ignored)': { source: 'fields', options: { tsconfigRaw: tc({ target: 'es1' }) } },
  'target ES2017, no public fields': { source: 'noFields', options: { tsconfigRaw: tc({ target: 'ES2017' }) } },
  'target es2020, useDefineForClassFields true': { source: 'fields', options: { tsconfigRaw: tc({ target: 'es2020', useDefineForClassFields: true }) } },
  'experimentalDecorators true, no decorators': { source: 'noDecorators', options: { tsconfigRaw: tc({ experimentalDecorators: true }) } },
  'experimentalDecorators false, no decorators': { source: 'noDecorators', options: { tsconfigRaw: tc({ experimentalDecorators: false }) } },
  'baseUrl and paths (ignored)': { source: 'paths', options: { tsconfigRaw: tc({ baseUrl: '.', paths: { '@lib/*': ['./lib/*'] } }) } },
  'fields esbuild does not read (ignored)': { source: 'strict', options: { tsconfigRaw: tc({ module: 'NodeNext', lib: ['DOM'], noEmit: true, types: ['node'], skipLibCheck: true }) } },
  'compilerOptions not an object (ignored)': { source: 'strict', options: { tsconfigRaw: JSON.stringify({ compilerOptions: 1 }) } },
  'empty tsconfigRaw': { source: 'strict', options: { tsconfigRaw: '' } },
};

// What the engines refuse by name where esbuild compiled it: `refused` is
// the field the refusal must name; esbuild's output must run.
const REFUSED_CASES = {
  'useDefineForClassFields false': { source: 'fields', options: { tsconfigRaw: tc({ useDefineForClassFields: false }) }, refused: 'useDefineForClassFields' },
  'target es2020': { source: 'fields', options: { tsconfigRaw: tc({ target: 'es2020' }) }, refused: 'target' },
  'experimentalDecorators true': { source: 'decorators', options: { tsconfigRaw: tc({ experimentalDecorators: true }) }, refused: 'experimentalDecorators' },
  'one refused field among honoured ones': {
    source: 'fields', options: { tsconfigRaw: tc({ jsx: 'react-jsx', strict: true, useDefineForClassFields: false }) }, refused: 'useDefineForClassFields',
  },
};

// What esbuild fails on, and so must the engines: `text`, when given, is
// esbuild's error, which the engines' must contain too.
// Scripts (no import or export, which would make each a module, strict anyway).
const SLOPPY = {
  'with': 'with (o) {}\n',
  'legacy octal': 'var a = 010;\n',
  'octal escape': 'var s = "\\01";\n',
  'delete of a name': 'var x = 1; delete x;\n',
  'reserved word': 'var package = 1;\n',
  'assignment to eval': 'eval = 1;\n',
};
const FAILING_CASES = [
  ...['transform', 'build'].flatMap((call) => [
    { call, name: 'tsconfig not JSON', source: 'jsx', loader: 'tsx', options: { tsconfigRaw: '{ compilerOptions }' } },
    { call, name: 'tsconfig with an unterminated block comment', source: 'jsx', loader: 'tsx', options: { tsconfigRaw: '{} /* unterminated' },
      text: 'Expected "*/" to terminate multi-line comment' },
    { call, name: 'invalid jsxFactory', source: 'jsx', loader: 'tsx', options: { jsxFactory: '1+2' } },
    { call, name: 'jsxFactory a constant', source: 'jsx', loader: 'tsx', options: { jsxFactory: '"h"' } },
    { call, name: 'jsxFactory a keyword', source: 'jsx', loader: 'tsx', options: { jsxFactory: 'true' } },
  ]),
  // `extends` naming a file: esbuild-wasm's build fails reading it; the bundler refuses it by name.
  { call: 'build', name: 'extends a file', source: 'strict', loader: 'ts', options: { tsconfigRaw: JSON.stringify({ extends: '/home/user/p/tsconfig.base.json' }) },
    ours: /tsconfigRaw "extends" is not supported/ },
  { call: 'build', name: 'extends ""', source: 'strict', loader: 'ts', options: { tsconfigRaw: JSON.stringify({ extends: '' }) }, ours: /tsconfigRaw "extends" is not supported/ },
  { call: 'build', name: 'extends [a file]', source: 'strict', loader: 'ts', options: { tsconfigRaw: JSON.stringify({ extends: ['./x.json'] }) },
    ours: /tsconfigRaw "extends" is not supported/ },
  // alwaysStrict: esbuild parses the file as strict code, whatever the format.
  ...Object.entries(SLOPPY).flatMap(([what, code]) => ['ts', 'js'].flatMap((loader) => ['esm', 'cjs'].map((format) => ({
    call: 'transform', name: `alwaysStrict, ${what}`, code, loader, format, options: { tsconfigRaw: tc({ alwaysStrict: true }) },
  })))),
];

// ── Running an output ───────────────────────────────────────────────────

const scratch = join(process.env.TMPDIR ?? tmpdir(), `tsconfig-jsx-differential-${process.pid}`);
const write = (path, text) => {
  mkdirSync(join(scratch, path, '..'), { recursive: true });
  writeFileSync(join(scratch, path), text);
};
// Recording stubs: each runtime function returns the call that was made.
const runtime = (label) => `
const trim = (args) => { const out = [...args]; while (out.length && out[out.length - 1] === undefined) out.pop(); return out; };
exports.Fragment = Symbol.for(${JSON.stringify(`${label}.Fragment`)});
exports.jsx = (...args) => ({ call: ${JSON.stringify(`${label}.jsx`)}, args: trim(args) });
exports.jsxs = (...args) => ({ call: ${JSON.stringify(`${label}.jsxs`)}, args: trim(args) });
exports.jsxDEV = (...args) => ({ call: ${JSON.stringify(`${label}.jsxDEV`)}, args: trim(args) });
`;
const classic = (label, names) => `
exports.${names[0]} = (...args) => ({ call: ${JSON.stringify(`${label}.${names[0]}`)}, args });
exports.${names[1]} = Symbol.for(${JSON.stringify(`${label}.${names[1]}`)});
`;
for (const pkg of ['react', 'preact']) {
  write(`node_modules/${pkg}/package.json`, JSON.stringify({
    name: pkg, exports: { '.': './index.js', './jsx-runtime': './jsx-runtime.js', './jsx-dev-runtime': './jsx-dev-runtime.js' },
  }));
  // createElement in both: the automatic runtime's fallback for a key after a spread imports it from the import source.
  write(`node_modules/${pkg}/index.js`, classic(pkg, ['createElement', 'Fragment']) + (pkg === 'preact' ? classic(pkg, ['h', 'Fragment']) : ''));
  write(`node_modules/${pkg}/jsx-runtime.js`, runtime(`${pkg}/jsx-runtime`));
  write(`node_modules/${pkg}/jsx-dev-runtime.js`, runtime(`${pkg}/jsx-dev-runtime`));
}
write('node_modules/jsx-lib/package.json', JSON.stringify({ name: 'jsx-lib', exports: './index.js' }));
write('node_modules/jsx-lib/index.js', classic('jsx-lib', ['h', 'Frag']));
write('node_modules/@lib/helper/package.json', JSON.stringify({ name: '@lib/helper', exports: './index.js' }));
write('node_modules/@lib/helper/index.js', 'exports.helper = () => 1;');
for (const name of ['a', 'u', 'd', 'ns', 'side', 'v', 'e', 'dw', 'bare']) {
  write(`src/${name}.js`, `exports.used = 'a'; exports.unusedValue = 1; exports.V = 2; exports.default = 3;`);
}

/** A value as data: symbols and functions by name, so two runs compare. */
function label(value) {
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return `function ${value.name}`;
  if (Array.isArray(value)) return value.map(label);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, label(value[k])]));
}

/** What a module imports: each specifier with the names it takes, in order (CommonJS: `require`). */
function importsOf(code) {
  const out = [];
  for (const m of code.matchAll(/^\s*import\s+(?:([^'"]*?)\s+from\s+)?["']([^"']+)["']/gm)) {
    const clause = m[1] ?? '';
    const names = [];
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) for (const part of named[1].split(',').map((x) => x.trim()).filter(Boolean)) names.push(part.split(/\s+as\s+/)[0]);
    if (/\*\s+as\s+/.test(clause)) names.push('*');
    if (/^\s*[\w$]+\s*(,|$)/.test(clause)) names.push('default');
    out.push(`${m[2]}: ${names.sort().join(' ')}`);
  }
  for (const m of code.matchAll(/\brequire\(["']([^"']+)["']\)/g)) out.push(`${m[1]}: require`);
  return out;
}

let serial = 0;
/** Run an output: an ES module, a CommonJS one, or an IIFE assigning `out`. */
async function evaluate(code, format) {
  if (/<(div|b)[\s>]/.test(code)) return { preservedJsx: true };
  const file = join(scratch, 'src', `out-${serial++}.${format === 'cjs' ? 'cjs' : 'mjs'}`);
  globalThis.__loaded = [];
  try {
    if (format === 'iife') return { exports: label(new Function(`${code}\nreturn out;`)()), loaded: globalThis.__loaded };
    writeFileSync(file, code);
    const exports = format === 'cjs' ? createRequire(file)(file) : { ...(await import(pathToFileURL(file).href)) };
    return { exports: label(exports), loaded: globalThis.__loaded };
  } catch (error) {
    return { throws: `${error.constructor.name}: ${error.message}` };
  }
}

// ── The two engines, through EsbuildService ─────────────────────────────

function memoryFs(files) {
  const at = new Map(Object.entries(files).map(([p, text]) => [p.replace(/^\/+/, ''), new TextEncoder().encode(text)]));
  const strip = (p) => p.replace(/^\/+|\/+$/g, '');
  const isDir = (p) => [...at.keys()].some((k) => k.startsWith(strip(p) + '/'));
  return {
    exists: (p) => at.has(strip(p)) || isDir(p),
    isDirectory: (p) => !at.has(strip(p)) && isDir(p),
    readFile: (p) => { const b = at.get(strip(p)); if (!b) throw new Error(`ENOENT ${p}`); return b; },
    readFileString: (p) => { const b = at.get(strip(p)); if (!b) throw new Error(`ENOENT ${p}`); return new TextDecoder().decode(b); },
  };
}

const clone = (value) => structuredClone(value);
const ENGINES = {
  esbuild: {
    transformer: () => new EsbuildService(memoryFs({}), { engine: esbuildEngine }),
    buildHost: async (options, plugin) => clone(await buildWithEsbuild(esbuild, clone(options), plugin)),
  },
  nimbus: {
    transformer: () => new EsbuildService(memoryFs({}), { engine: async () => oxcEngine }),
    buildHost: async (options, plugin) => clone(await buildWithRolldown(rolldown, clone(options), plugin)),
  },
};

const warningsOf = (warnings) => (warnings ?? []).map((w) => w.text).sort();

async function transformOutcome(engine, code, loader, format, options) {
  try {
    const result = await ENGINES[engine].transformer().transform(code, { loader, format, ...options });
    return { imports: importsOf(result.code), runs: await evaluate(result.code, format), warnings: warningsOf(result.warnings) };
  } catch (error) {
    return { failure: error.message };
  }
}

// A build's project: the entry and the modules it imports, as side effects say.
const PROJECT_MODULES = Object.fromEntries(['a', 'u', 'd', 'ns', 'side', 'v', 'e', 'dw', 'bare'].map((name) => [
  `/home/user/p/src/${name}.ts`,
  `(globalThis.__loaded ??= []).push(${JSON.stringify(name)});\nexport const used = 'a'; export const unusedValue = 1; export const V = 2; export default 3;\n`,
]));

/**
 * A build's output as compared: bundled, an external module's import names
 * are the bundler's to drop when the bundle never uses them (rolldown keeps
 * `import "x"` where esbuild kept the names; the module still runs first), and
 * its imports of one module the bundler's to merge, so a build's imports are
 * the modules it imports, each once. What the names did shows in
 * the run. jsxDEV's `fileName` is the module's absolute path: esbuild wrote
 * 0.14.0's plugin namespace before it (`nimbus-vfs:/home/user/…`), which is
 * not part of the path, so the expected value is esbuild's without it.
 */
function buildComparable(engine, outcome) {
  if (!outcome.imports) return outcome;
  const fileName = (value) => {
    if (Array.isArray(value)) return value.map(fileName);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'fileName' && typeof v === 'string' ? v.replace(/^nimbus-vfs:/, '') : fileName(v)]));
  };
  const modules = [...new Set(outcome.imports.map((entry) => entry.split(':')[0]))];
  return { ...outcome, imports: modules, runs: engine === 'esbuild' ? fileName(outcome.runs) : outcome.runs };
}

async function buildOutcome(engine, code, loader, format, options) {
  const entry = `/home/user/p/src/app.${loader}`;
  const service = new EsbuildService(memoryFs({ ...PROJECT_MODULES, [entry]: code }), { buildHost: ENGINES[engine].buildHost });
  try {
    const result = await service.build([entry], { format, ...(format === 'iife' ? { globalName: 'out' } : {}), ...options });
    const { contents } = result.outputFiles.find((f) => f.path.endsWith('.js'));
    const output = typeof contents === 'string' ? contents : new TextDecoder().decode(contents);
    return buildComparable(engine, { imports: importsOf(output), runs: await evaluate(output, format), warnings: warningsOf(result.warnings) });
  } catch (error) {
    return { failure: error.message };
  }
}

// ── Comparison ──────────────────────────────────────────────────────────

const differences = [];
const counts = { same: 0, refused: 0, failing: 0 };
const show = (theirs, ours) => `\n    esbuild: ${JSON.stringify(theirs)}\n    nimbus:  ${JSON.stringify(ours)}`;
const outcomeOf = (call) => (call === 'build' ? buildOutcome : transformOutcome);

/** A case both engines compile: the same outcome, and each ran and made what `expect` says. */
async function same(name, run, expect) {
  const theirs = await run('esbuild');
  const ours = await run('nimbus');
  counts.same++;
  if (!expect(theirs) || !expect(ours)) {
    differences.push(`${name}: did not compile, run and record what its source makes${show(theirs, ours)}`);
    return;
  }
  try {
    assert.deepEqual(ours, theirs);
  } catch {
    differences.push(`${name}${show(theirs, ours)}`);
  }
}

/** A field the engines refuse by name where esbuild's output runs. */
async function refused(name, run, field, expect) {
  const theirs = await run('esbuild');
  const ours = await run('nimbus');
  counts.refused++;
  const named = ours.failure?.includes(`compilerOptions.${field} `);
  if (!named || !expect(theirs)) differences.push(`${name}: expected esbuild's output to run and a refusal naming ${field}${show(theirs, ours)}`);
}

/** What esbuild fails on: the engines fail too (with esbuild's words, or `ours`, where given). */
async function failing(name, run, { text, ours: oursPattern }) {
  const theirs = await run('esbuild');
  const ours = await run('nimbus');
  counts.failing++;
  const ok = Boolean(theirs.failure) && Boolean(ours.failure)
    && (!text || (theirs.failure.includes(text) && ours.failure.includes(text)))
    && (!oursPattern || oursPattern.test(ours.failure));
  if (!ok) differences.push(`${name}: both must fail${text ? `, saying ${JSON.stringify(text)}` : ''}${show(theirs, ours)}`);
}

try {
  for (const [name, options] of Object.entries(JSX_CASES)) {
    const preserve = options.jsx === 'preserve';
    for (const loader of ['tsx', 'jsx']) {
      for (const format of preserve ? ['esm'] : ['esm', 'cjs']) {
        await same(`transform ${loader} ${format}: ${name}`, (engine) => transformOutcome(engine, SOURCES.jsx, loader, format, options), EXPECT.jsx);
      }
      await same(`build ${loader} esm: ${name}`, (engine) => buildOutcome(engine, SOURCES.jsx, loader, 'esm', options), EXPECT.jsx);
    }
  }
  const sourceFor = (source, loader) => (loader === 'js' ? SOURCES[source].replace(/: string\[\]|: number|: T \| U \| W \| 1|import type .*\n|type [TW],? ?/g, '') : SOURCES[source]);
  for (const [name, { source, loader = 'ts', options }] of Object.entries(FIELD_CASES)) {
    const code = sourceFor(source, loader);
    for (const format of ['esm', 'cjs']) {
      await same(`transform ${loader} ${format}: ${name}`, (engine) => transformOutcome(engine, code, loader, format, options), EXPECT[source]);
    }
    // An IIFE only for strictness, the one thing its wrapper changes.
    for (const format of source === 'strict' ? ['esm', 'cjs', 'iife'] : ['esm', 'cjs']) {
      await same(`build ${loader} ${format}: ${name}`, (engine) => buildOutcome(engine, code, loader, format, options), EXPECT[source]);
    }
  }
  // `extends` naming a file: a transform never reads it.
  for (const ext of ['./base.json', '', ['./x.json']]) {
    await same(`transform ts esm: extends ${JSON.stringify(ext)} (ignored)`,
      (engine) => transformOutcome(engine, SOURCES.strict, 'ts', 'esm', { tsconfigRaw: JSON.stringify({ extends: ext }) }), EXPECT.strict);
  }
  for (const [name, { source, options, refused: field }] of Object.entries(REFUSED_CASES)) {
    for (const format of ['esm', 'cjs']) {
      await refused(`transform ts ${format}: ${name}`, (engine) => transformOutcome(engine, SOURCES[source], 'ts', format, options), field, EXPECT[source]);
      await refused(`build ts ${format}: ${name}`, (engine) => buildOutcome(engine, SOURCES[source], 'ts', format, options), field, EXPECT[source]);
    }
  }
  for (const { call, name, source, code, loader, format = 'esm', options, text, ours } of FAILING_CASES) {
    await failing(`${call} ${loader} ${format}: ${name}`, (engine) => outcomeOf(call)(engine, code ?? SOURCES[source], loader, format, options), { text, ours });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
  await stopEsbuildEngine();
}

const total = counts.same + counts.refused + counts.failing;
assert.equal(differences.length, 0, `${differences.length} of ${total} cases differ from esbuild 0.24.2:\n  ${differences.join('\n  ')}`);
console.log(`tsconfig-jsx-differential OK: ${counts.same} cases compile, run and record the same as esbuild 0.24.2; `
  + `${counts.refused} refused by field name where esbuild's output runs; ${counts.failing} fail where esbuild fails`);
