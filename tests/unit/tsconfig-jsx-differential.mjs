#!/usr/bin/env bun
// esbuild's JSX options and tsconfigRaw, through EsbuildService's transform()
// (Oxc, the staged wasm) and build() (rolldown), against esbuild-wasm 0.24.2,
// Nimbus 0.14.0's engine, on the same calls. Compared on what the output
// does: the imports it emits and what running it makes, each module run
// against recording stubs of the JSX runtimes (an element is the call that
// made it: which function of which module, with what), plus esbuild's
// warnings about the tsconfig. A tsconfig field the engines cannot honour is
// refused by name, and only where esbuild's output would differ from theirs
// (runtime/tsconfig-raw.ts): those cases assert the refusal instead.

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
const rolldown = await import(createRequire(new URL('../../packages/worker/package.json', import.meta.url)).resolve('rolldown'));

const tc = (compilerOptions) => JSON.stringify({ compilerOptions });

// ── Sources ─────────────────────────────────────────────────────────────

// Every JSX shape a runtime sees differently: attributes, a key after a
// spread, mapped children with keys, a fragment, a single child. The imports
// serve the classic runtimes; TypeScript drops the ones a mode leaves unused.
const JSX_SOURCE = `import React from 'react';
import { h, Frag } from 'jsx-lib';
const p = { title: 't' };
export const el = <div id="a"><span key="k" {...p} />{[1, 2].map((n) => <i key={n}>{n}</i>)}<>frag</></div>;
export const one = <b>1</b>;
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
  'importsNotUsedAsValues preserve': { source: 'imports', options: { tsconfigRaw: tc({ importsNotUsedAsValues: 'preserve' }) }, refused: 'importsNotUsedAsValues' },
  'importsNotUsedAsValues error': { source: 'imports', options: { tsconfigRaw: tc({ importsNotUsedAsValues: 'error' }) }, refused: 'importsNotUsedAsValues' },
  'alwaysStrict true': { source: 'strict', options: { tsconfigRaw: tc({ alwaysStrict: true }) } },
  'alwaysStrict false': { source: 'strict', options: { tsconfigRaw: tc({ alwaysStrict: false }) } },
  'strict true': { source: 'strict', options: { tsconfigRaw: tc({ strict: true }) } },
  'strict true, alwaysStrict false': { source: 'strict', options: { tsconfigRaw: tc({ strict: true, alwaysStrict: false }) } },
  'useDefineForClassFields true': { source: 'fields', options: { tsconfigRaw: tc({ useDefineForClassFields: true }) } },
  'useDefineForClassFields false': { source: 'fields', options: { tsconfigRaw: tc({ useDefineForClassFields: false }) }, refused: 'useDefineForClassFields' },
  'useDefineForClassFields false, no public fields': { source: 'noFields', options: { tsconfigRaw: tc({ useDefineForClassFields: false }) } },
  'useDefineForClassFields false, JavaScript': { source: 'fields', loader: 'js', options: { tsconfigRaw: tc({ useDefineForClassFields: false }) } },
  'target es2022': { source: 'fields', options: { tsconfigRaw: tc({ target: 'es2022' }) } },
  'target ESNext': { source: 'fields', options: { tsconfigRaw: tc({ target: 'ESNext' }) } },
  'target unknown (warned, ignored)': { source: 'fields', options: { tsconfigRaw: tc({ target: 'es1' }) } },
  'target es2020': { source: 'fields', options: { tsconfigRaw: tc({ target: 'es2020' }) }, refused: 'target' },
  'target ES2017, no public fields': { source: 'noFields', options: { tsconfigRaw: tc({ target: 'ES2017' }) } },
  'target es2020, useDefineForClassFields true': { source: 'fields', options: { tsconfigRaw: tc({ target: 'es2020', useDefineForClassFields: true }) } },
  'experimentalDecorators true': { source: 'decorators', options: { tsconfigRaw: tc({ experimentalDecorators: true }) }, refused: 'experimentalDecorators' },
  'experimentalDecorators true, no decorators': { source: 'noDecorators', options: { tsconfigRaw: tc({ experimentalDecorators: true }) } },
  'experimentalDecorators false, no decorators': { source: 'noDecorators', options: { tsconfigRaw: tc({ experimentalDecorators: false }) } },
  'baseUrl and paths (ignored)': { source: 'paths', options: { tsconfigRaw: tc({ baseUrl: '.', paths: { '@lib/*': ['./lib/*'] } }) } },
  'fields esbuild does not read (ignored)': { source: 'strict', options: { tsconfigRaw: tc({ module: 'NodeNext', lib: ['DOM'], noEmit: true, types: ['node'], skipLibCheck: true }) } },
  'compilerOptions not an object (ignored)': { source: 'strict', options: { tsconfigRaw: JSON.stringify({ compilerOptions: 1 }) } },
  'empty tsconfigRaw': { source: 'strict', options: { tsconfigRaw: '' } },
  'one refused field among honoured ones': {
    source: 'fields', options: { tsconfigRaw: tc({ jsx: 'react-jsx', strict: true, useDefineForClassFields: false }) }, refused: 'useDefineForClassFields',
  },
};

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
  write(`node_modules/${pkg}/index.js`, classic(pkg, pkg === 'react' ? ['createElement', 'Fragment'] : ['h', 'Fragment']));
  write(`node_modules/${pkg}/jsx-runtime.js`, runtime(`${pkg}/jsx-runtime`));
  write(`node_modules/${pkg}/jsx-dev-runtime.js`, runtime(`${pkg}/jsx-dev-runtime`));
}
write('node_modules/jsx-lib/package.json', JSON.stringify({ name: 'jsx-lib', exports: './index.js' }));
write('node_modules/jsx-lib/index.js', classic('jsx-lib', ['h', 'Frag']));
write('node_modules/@lib/helper/package.json', JSON.stringify({ name: '@lib/helper', exports: './index.js' }));
write('node_modules/@lib/helper/index.js', 'exports.helper = () => 1;');
for (const name of ['a', 'u', 'd', 'ns']) {
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
const PROJECT_MODULES = Object.fromEntries(['a', 'u', 'd', 'ns'].map((name) => [
  `/home/user/p/src/${name}.ts`,
  `(globalThis.__loaded ??= []).push(${JSON.stringify(name)});\nexport const used = 'a'; export const unusedValue = 1; export const V = 2; export default 3;\n`,
]));

/**
 * A build's output as compared: bundled, an external module's import names
 * are the bundler's to drop when the bundle never uses them (rolldown keeps
 * `import "x"` where esbuild kept the names; the module still runs first), so
 * a build's imports are the modules it imports. What the names did shows in
 * the run. jsxDEV's `fileName` names the module as each bundler does, its
 * path (rolldown: from `/`, without the slash; esbuild: in its namespace).
 */
function buildComparable(outcome) {
  if (!outcome.imports) return outcome;
  const fileName = (value) => {
    if (Array.isArray(value)) return value.map(fileName);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'fileName' && typeof v === 'string' ? v.replace(/^(nimbus-vfs:)?\/?/, '/') : fileName(v)]));
  };
  return { ...outcome, imports: outcome.imports.map((entry) => entry.split(':')[0]), runs: fileName(outcome.runs) };
}

async function buildOutcome(engine, code, loader, format, options) {
  const entry = `/home/user/p/src/app.${loader}`;
  const service = new EsbuildService(memoryFs({ ...PROJECT_MODULES, [entry]: code }), { buildHost: ENGINES[engine].buildHost });
  try {
    const result = await service.build([entry], { format, ...(format === 'iife' ? { globalName: 'out' } : {}), ...options });
    const { contents } = result.outputFiles.find((f) => f.path.endsWith('.js'));
    const output = typeof contents === 'string' ? contents : new TextDecoder().decode(contents);
    return buildComparable({ imports: importsOf(output), runs: await evaluate(output, format), warnings: warningsOf(result.warnings) });
  } catch (error) {
    return { failure: error.message };
  }
}

// ── Comparison ──────────────────────────────────────────────────────────

const differences = [];
let compared = 0;
let refusals = 0;

async function compare(name, run, refusedField) {
  const theirs = await run('esbuild');
  const ours = await run('nimbus');
  compared++;
  if (refusedField) {
    refusals++;
    const named = ours.failure && ours.failure.includes(`compilerOptions.${refusedField} `) || ours.failure?.includes(`"${refusedField}"`);
    if (!named) differences.push(`${name}: expected a refusal naming ${refusedField}\n    nimbus:  ${JSON.stringify(ours)}`);
    else if (theirs.failure) differences.push(`${name}: esbuild failed too, so this is no refusal of its output: ${theirs.failure}`);
    return;
  }
  try {
    assert.deepEqual(ours, theirs);
  } catch {
    differences.push(`${name}\n    esbuild: ${JSON.stringify(theirs)}\n    nimbus:  ${JSON.stringify(ours)}`);
  }
}

try {
  for (const [name, options] of Object.entries(JSX_CASES)) {
    const preserve = options.jsx === 'preserve';
    for (const loader of ['tsx', 'jsx']) {
      for (const format of preserve ? ['esm'] : ['esm', 'cjs']) {
        await compare(`transform ${loader} ${format}: ${name}`, (engine) => transformOutcome(engine, SOURCES.jsx, loader, format, options));
      }
      await compare(`build ${loader} esm: ${name}`, (engine) => buildOutcome(engine, SOURCES.jsx, loader, 'esm', options));
    }
  }
  for (const [name, { source, loader = 'ts', options, refused }] of Object.entries(FIELD_CASES)) {
    const code = loader === 'js' ? SOURCES[source].replace(/: string\[\]|: number/g, '') : SOURCES[source];
    for (const format of ['esm', 'cjs']) {
      await compare(`transform ${loader} ${format}: ${name}`, (engine) => transformOutcome(engine, code, loader, format, options), refused);
    }
    // An IIFE only for strictness, the one thing its wrapper changes.
    for (const format of source === 'strict' ? ['esm', 'cjs', 'iife'] : ['esm', 'cjs']) {
      await compare(`build ${loader} ${format}: ${name}`, (engine) => buildOutcome(engine, code, loader, format, options), refused);
    }
  }
  // tsconfig `extends` names a file: a transform never reads it, and esbuild's
  // build failed on it (esbuild-wasm reads no file); the bundler refuses it by name.
  await compare('transform ts esm: extends (ignored)', (engine) => transformOutcome(engine, SOURCES.strict, 'ts', 'esm', { tsconfigRaw: JSON.stringify({ extends: './base.json' }) }));
  {
    const options = { tsconfigRaw: JSON.stringify({ extends: '/home/user/p/tsconfig.base.json', compilerOptions: { jsx: 'react-jsx' } }) };
    const theirs = await buildOutcome('esbuild', SOURCES.strict, 'ts', 'esm', options);
    const ours = await buildOutcome('nimbus', SOURCES.strict, 'ts', 'esm', options);
    compared++;
    if (!/Cannot read file/.test(theirs.failure ?? '') || !/tsconfigRaw "extends" is not supported/.test(ours.failure ?? '')) {
      differences.push(`build ts esm: extends: esbuild fails reading it, the bundler refuses it by name\n    esbuild: ${JSON.stringify(theirs)}\n    nimbus:  ${JSON.stringify(ours)}`);
    }
  }
  // A tsconfig that is not JSON fails both, and esbuild's own invalid JSX factory too.
  for (const [name, options] of Object.entries({ 'tsconfig not JSON': { tsconfigRaw: '{ compilerOptions }' }, 'invalid jsxFactory': { jsxFactory: '1+2' } })) {
    for (const call of [transformOutcome, buildOutcome]) {
      const theirs = await call('esbuild', SOURCES.jsx, 'tsx', 'esm', options);
      const ours = await call('nimbus', SOURCES.jsx, 'tsx', 'esm', options);
      compared++;
      if (!theirs.failure || !ours.failure) differences.push(`${call.name} tsx esm: ${name}: both fail\n    esbuild: ${JSON.stringify(theirs)}\n    nimbus:  ${JSON.stringify(ours)}`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
  await stopEsbuildEngine();
}

assert.equal(differences.length, 0, `${differences.length} of ${compared} cases differ from esbuild 0.24.2:\n  ${differences.join('\n  ')}`);
console.log(`tsconfig-jsx-differential OK (${compared} cases the same as esbuild 0.24.2, ${refusals} of them refused by field name)`);
