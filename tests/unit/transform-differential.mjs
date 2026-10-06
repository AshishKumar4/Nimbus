#!/usr/bin/env bun
// The transform facet's engine (Nimbus's Oxc build, lib/oxc-engine.mjs)
// against the one it replaced, esbuild-wasm 0.24.2, on the transforms Nimbus
// makes:
//
//   cell     a launch's module cell: prepareBundleCell -> runTransformRequest
//            (CommonJS, import.meta bound to the module, dynamic import() kept
//            for the process loader, top-level await lowered) -> settleBundleCell
//   entry    a launch's ES module entry (runtime-registry.ts): CommonJS with
//            import.meta.url and import.meta.resolve defined
//   browser  a Vite dev module (vite-dev-server.ts): ESM, automatic JSX, the
//            dev defines, no import() or import.meta support, inline map
//
// Each output is compiled and run in Nimbus's CommonJS cell wrapper with every
// require mocked, and what a program can observe is compared: the requires in
// order, what it threw, module.exports' keys and each value's type, function
// name and arity, and __esModule. Text is not compared: the printers differ.
// A divergence must be listed, with its reason, in the fixture's DIVERGENT.

import assert from 'node:assert/strict';
import { CASES, DIVERGENT } from '../fixtures/transform-differential/cases.mjs';
import { generateTransformFacetRuntimeSource } from '../../packages/core/src/runtime/esbuild-service.ts';
import { prepareBundleCell, settleBundleCell } from '../../packages/core/src/runtime/bundle-cell-transform.ts';
import { rewriteDynamicImports } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';
import { lowerAsyncModule } from '../../packages/core/src/runtime/async-module-lowering.ts';
import { wrapCommonJsCell } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { esbuildEngine, stopEsbuildEngine } from './lib/esbuild-engine.mjs';
import { oxcEngine } from './lib/oxc-engine.mjs';

const { runTransformRequest } = new Function(`${generateTransformFacetRuntimeSource()}\nreturn { runTransformRequest };`)();

// esbuild as Nimbus ran it: the browser build over the compiled wasm.
const esbuild = await esbuildEngine();
assert.equal(esbuild.version, '0.24.2');
const engines = { esbuild, oxc: oxcEngine };

/** A callable, constructible stand-in for any required module, reading as anything. */
function anything() {
  return new Proxy(function () {}, {
    get(target, key) {
      if (key === Symbol.toPrimitive) return () => 1;
      if (key === 'then' || key === '__esModule') return undefined;
      if (key === Symbol.iterator) return function* () {};
      if (key === 'prototype') return Reflect.get(target, key);
      return anything();
    },
    apply: () => anything(),
    construct: () => anything(),
  });
}

function describe(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return `${typeof value}:${String(value)}`;
  if (typeof value === 'function') return `function:${value.name}/${value.length}`;
  return `object:${Object.keys(value).sort().join(',')}`;
}

/**
 * Run a CommonJS cell as Nimbus's wrapper does, and settle what a lowered
 * (top-level await) cell returns; report what a program could see. A
 * module's `__trace(label)` records into `requires`, so the order of its own
 * side effects and its dependencies' is compared too.
 */
async function observe(code, lowered) {
  const holder = {};
  try {
    new Function('module', wrapCommonJsCell(code, lowered ? 'block' : 'function').text)(holder);
  } catch (error) {
    return { compiles: false, error: error.name };
  }
  const requires = [];
  const module = { exports: {}, __nimbusImportMeta: { url: 'file:///app/x.js', dirname: '/app', filename: '/app/x.js', resolve: (s) => s } };
  globalThis.__nimbusDynamicImport = (_parent, specifier) => { requires.push(`import(${String(specifier)})`); return Promise.resolve({}); };
  globalThis.__trace = (label) => requires.push(`trace:${label}`);
  let threw = null;
  const log = console.log;
  console.log = () => {};
  try {
    const returned = holder.exports.call(module.exports, module.exports, (s) => { requires.push(s); return anything(); }, module, '/app/x.js', '/app');
    if (returned && typeof returned.then === 'function') await returned;
  } catch (error) {
    // The message names the binding esbuild or Oxc chose; the constructor does not.
    threw = error.constructor.name;
  } finally {
    console.log = log;
  }
  const exported = module.exports;
  const keys = exported !== null && (typeof exported === 'object' || typeof exported === 'function') ? Object.keys(exported) : [];
  return {
    requires,
    threw,
    esModule: Boolean(exported?.__esModule),
    type: typeof exported,
    exports: keys.map((key) => { try { return `${key}=${describe(exported[key])}`; } catch (error) { return `${key} throws ${error.constructor.name}`; } }),
  };
}

const loaderOf = (name) => (/\.tsx$/.test(name) ? 'tsx' : /\.[mc]?ts$/.test(name) ? 'ts' : /\.jsx$/.test(name) ? 'jsx' : 'js');
const outcomes = {
  async cell(engine, name, source) {
    const cell = prepareBundleCell(`app/${name}`, source);
    if (!('request' in cell)) return null;
    let outcome;
    try {
      outcome = await runTransformRequest(engine, cell.request.code, cell.request.options, rewriteDynamicImports, lowerAsyncModule);
    } catch (error) {
      outcome = { error: String(error.message) };
    }
    const settled = settleBundleCell(cell, outcome);
    return settled.failed ? { refused: true } : await observe(settled.code, settled.lowered);
  },
  async entry(engine, name, source) {
    const url = `file:///app/${name}`;
    try {
      // The entry script's request, as runtime-registry.ts makes it.
      const { code } = await runTransformRequest(engine, source, { loader: loaderOf(name), format: 'cjs', dynamicImportParent: url, moduleMetadata: true }, rewriteDynamicImports, lowerAsyncModule);
      return await observe(code, true);
    } catch (error) {
      return { refused: true, topLevelAwait: /top-level await.*not supported.*cjs/i.test(String(error.message)) };
    }
  },
  async browser(engine, name, source) {
    const define = { 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false', 'import.meta.env.MODE': '"development"', 'import.meta.env.SSR': 'false', 'process.env.NODE_ENV': '"development"', global: 'globalThis', 'import.meta.env.BASE_URL': '"/"' };
    let code;
    try {
      ({ code } = await engine.transform(source, { loader: loaderOf(name) === 'js' ? 'ts' : loaderOf(name), format: 'esm', target: 'esnext', jsx: 'automatic', define, sourcemap: 'inline', supported: { 'dynamic-import': false, 'import-meta': false } }));
    } catch {
      return { refused: true };
    }
    assert.match(code, /\/\/# sourceMappingURL=data:application\/json;(charset=utf-8;)?base64,/, `${name}: the browser module carries its map`);
    // One engine reads both outputs as CommonJS, so only the first pass differs.
    try {
      const { code: cjs } = await esbuild.transform(code, { loader: 'js', format: 'cjs', supported: { 'dynamic-import': true, 'import-meta': true } });
      return await observe(cjs, true);
    } catch (error) {
      // Where in the output it was refused depends on the printer; why does not.
      return { refused: true, reread: String(error.message).split('\n')[1].replace(/^<stdin>:\d+:\d+: /, '') };
    }
  },
};

let compared = 0;
let equal = 0;
const divergent = new Set();
const unexpected = [];
for (const [name, source] of CASES) {
  for (const [path, outcome] of Object.entries(outcomes)) {
    const [before, after] = [await outcome(engines.esbuild, name, source), await outcome(engines.oxc, name, source)];
    compared++;
    if (JSON.stringify(before) === JSON.stringify(after)) { equal++; continue; }
    if (DIVERGENT[name]) divergent.add(name);
    else unexpected.push(`${name} (${path}) differs:\n  esbuild-wasm: ${JSON.stringify(before)}\n  oxc:          ${JSON.stringify(after)}`);
  }
}
assert.deepEqual(unexpected, [], unexpected.join('\n'));
assert.deepEqual([...divergent].sort(), Object.keys(DIVERGENT).sort(), 'every listed divergence still diverges');
console.log(`  ok  ${CASES.length} modules x ${Object.keys(outcomes).length} transforms: ${equal} of ${compared} equal, the rest the ${divergent.size} listed divergences`);

// ── A top-level-await module's dependencies run before its body, as in Node ─
{
  // Node evaluates every module the source requests, in source order, before
  // the body; the lowering hoists re-exports' requires with the imports'.
  const source = "__trace('body'); await 0; export { x } from 'y'; export * from 'z'; import 'w';";
  for (const [name, engine] of Object.entries(engines)) {
    const seen = await outcomes.cell(engine, 'tla-reexport-order.mjs', source);
    assert.deepEqual(seen.requires, ['y', 'z', 'w', 'trace:body'], `${name}: ${JSON.stringify(seen)}`);
    assert.ok(seen.exports.some((e) => e.startsWith('x=')), `${name}: ${JSON.stringify(seen.exports)}`);
  }
  // The module's own bindings, an import named `Object` included, cannot
  // reach what the lowering's generated code reads.
  const shadowing = "import Object from 'dep'; export const answer = 7; await 0;";
  for (const [name, engine] of Object.entries(engines)) {
    const seen = await outcomes.cell(engine, 'tla-shadow-object.mjs', shadowing);
    assert.equal(seen.threw, null, `${name}: ${JSON.stringify(seen)}`);
    assert.ok(seen.exports.includes('answer=number:7'), `${name}: ${JSON.stringify(seen.exports)}`);
  }
  console.log('  ok  a top-level-await module requires its dependencies before its body runs');
}

// ── Deep modules: Oxc, or past its stack esbuild (oxcTransformHost's rule) ──
{
  // Oxc's passes recurse once per level of nesting on the host's stack; a
  // module deeper than it holds goes to esbuild. Under Node (V8, as workerd)
  // they hold 4,784 concatenated terms, a 1,952-arm ternary, 1,415 chained
  // calls and arrays 585 deep; Bun's stack holds more (3,027 deep arrays). Sizes stay where esbuild's
  // own wasm fits a Worker (it grows to 108 MiB for 3,000 concatenated terms,
  // 268 MiB for 5,000), and where one esbuild instance can take them all in
  // turn (esbuild-facet-stack-fallback.mjs runs a 5,000-deep array on a fresh one).
  const terms = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const deep = {
    'concat-3000.mjs': `export const s = ${terms(3000, (i) => `"p${i}"`).join(' + ')};`,
    'ternary-1000.mjs': `export const f = (a) => ${terms(1000, (i) => `a === ${i} ? "v${i}" :`).join(' ')} null;`,
    'ternary-5000.mjs': `export const f = (a) => ${terms(5000, (i) => `a === ${i} ? "v${i}" :`).join(' ')} null;`,
    'nested-300.mjs': `export const x = ${'['.repeat(300)}1${']'.repeat(300)};`,
    'nested-4000.mjs': `export const x = ${'['.repeat(4000)}1${']'.repeat(4000)};`,
    'chain-3000.mjs': `import { q } from 'q'; export const c = () => q${'.m()'.repeat(3000)};`,
    // What a minifier makes of a large switch and a string table.
    'minified-switch.mjs': `import{t as e}from"t";export function m(r){return ${terms(2500, (i) => `r===${i}?e("k${i}")`).join(':')}:void 0}export const s=${terms(1500, (i) => `"${i.toString(36)}"`).join('+')};`,
  };
  const settle = async (engine, name, source) => {
    const cell = prepareBundleCell(`app/${name}`, source);
    let outcome;
    try {
      outcome = await runTransformRequest(engine, cell.request.code, cell.request.options, rewriteDynamicImports, lowerAsyncModule);
    } catch (error) {
      // The transform facet's own mapping (facets/oxc-transform.ts OXC_FACET_BODY).
      outcome = error && error.stackExhausted === true ? { error: String(error.message), stackExhausted: true } : { error: String(error.message) };
    }
    return { cell, outcome };
  };
  let viaOxc = 0;
  let viaEsbuild = 0;
  for (const [name, source] of Object.entries(deep)) {
    const expected = await outcomes.cell(esbuild, name, source);
    let { cell, outcome } = await settle(oxcEngine, name, source);
    if (outcome.stackExhausted === true) {
      viaEsbuild++;
      ({ cell, outcome } = await settle(esbuild, name, source));
    } else viaOxc++;
    const settled = settleBundleCell(cell, outcome);
    const actual = settled.failed ? { refused: true } : await observe(settled.code, settled.lowered);
    assert.deepEqual(actual, expected, `${name}: ${JSON.stringify(actual).slice(0, 300)}`);
  }
  assert.ok(viaOxc > 0 && viaEsbuild > 0, `both routes taken: ${viaOxc} by Oxc, ${viaEsbuild} by esbuild`);
  console.log(`  ok  ${Object.keys(deep).length} deep modules equal: ${viaOxc} by Oxc, ${viaEsbuild} past its stack by esbuild`);
}

// ── The CommonJS shape other code reads by name ─────────────────────────────
{
  // server-launch.ts unwraps `__toESM(require(...))` and `__toCommonJS` by
  // name; module.exports is the __toCommonJS object, __esModule unenumerable.
  const { code } = await oxcEngine.transform(
    "import d from 'a'; import { x } from 'b'; export const y = x(d); export default 1;",
    { loader: 'js', format: 'cjs' },
  );
  assert.match(code, /var import_a = __toESM\(require\("a"\)\);/);
  assert.match(code, /var import_b = require\("b"\);/);
  assert.match(code, /module\.exports = __toCommonJS\(stdin_exports\);/);
  assert.match(code, /\(0, import_b\.x\)\(import_a\.default\)/);
  // An imported tag is called without its record as receiver, as an ES
  // module calls it (esbuild 0.24 passes the record; the mock above cannot tell).
  const { code: tagged } = await oxcEngine.transform("import { tag } from 't'; tag`a`;", { loader: 'js', format: 'cjs' });
  assert.match(tagged, /\(0, import_t\.tag\)`a`/);
  console.log('  ok  CommonJS output keeps the helper and record names Nimbus reads');
}

// ── Refusals keep esbuild's message shape ───────────────────────────────────
{
  await assert.rejects(oxcEngine.transform('await 1; export {};', { loader: 'js', format: 'cjs' }),
    (error) => /^Transform failed with 1 error:\n<stdin>:1:0: ERROR: Top-level await is currently not supported with the "cjs" output format$/.test(error.message) && error.errors[0].location.line === 1);
  await assert.rejects(oxcEngine.transform('let a = ;', { loader: 'js', format: 'cjs' }), /Transform failed with 1 error:\n<stdin>:1:8: ERROR: /);
  await assert.rejects(oxcEngine.transform('x', { loader: 'css' }), /oxc transform: loader "css" is not supported/);
  await assert.rejects(oxcEngine.transform('x', { target: 'es2020' }), /oxc transform: target "es2020" is not supported/);
  await assert.rejects(oxcEngine.transform('<C />', { loader: 'jsx', jsx: 'preserve', format: 'cjs' }), /jsx "preserve" is not supported with format "cjs"/);
  console.log('  ok  refusals read as esbuild\'s, and unsupported options are refused, not ignored');
}

await stopEsbuildEngine();
console.log('transform-differential OK');
