#!/usr/bin/env bun
// The transform facet's engine (Nimbus's Oxc build, lib/oxc-engine.mjs)
// against the one it replaced, esbuild-wasm 0.24.2, on the transforms Nimbus
// makes:
//
//   commonjs an explicit format:'cjs' transform through runTransformRequest,
//            with dynamic import() routed and top-level await refused
//   browser  a Vite dev module (vite-dev-server.ts): ESM, automatic JSX, the
//            dev defines, no import() or import.meta support, inline map
//
// Each output is compiled and run in Nimbus's CommonJS cell wrapper with every
// require mocked, and what a program can observe is compared: the requires in
// order, what it threw, module.exports' keys and each value's type, function
// name and arity, and __esModule. Text is not compared: the printers differ.
// A divergence must be listed, with its reason, in the fixture's DIVERGENT.

import assert from 'node:assert/strict';
import { tokenizer } from 'acorn';
import { CASES, DIVERGENT } from '../fixtures/transform-differential/cases.mjs';
import { generateTransformFacetRuntimeSource } from '../../packages/core/src/runtime/esbuild-service.ts';
import { rewriteDynamicImports } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';
import { readEsModule } from '../../packages/core/src/runtime/native-esm.ts';
import { rewriteProvidedCommonJsModules } from '../../packages/core/src/runtime/provided-packages.ts';
import { wrapCommonJsCell } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { programLaunchesServer } from '../../packages/core/src/runtime/server-launch.ts';
import { esbuildEngine, stopEsbuildEngine } from './lib/esbuild-engine.mjs';
import { oxcEngine } from './lib/oxc-engine.mjs';
import { originalPosition } from './lib/sourcemap-vlq.mjs';

const { runTransformRequest } = new Function(`${generateTransformFacetRuntimeSource()}\nreturn { runTransformRequest };`)();
// What the transform facet's preamble installs beside its engine.
const runtime = { rewriteDynamicImports, readEsModule, rewriteProvidedCommonJsModules };

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
 * Run the explicit CommonJS output in Nimbus's wrapper and report what a
 * program could see. A module's `__trace(label)` records into `requires`,
 * so the order of its own
 * side effects and its dependencies' is compared too.
 */
async function observe(code, dependencies = null) {
  const holder = {};
  try {
    new Function('module', wrapCommonJsCell(code, 'block').text)(holder);
  } catch (error) {
    return { compiles: false, error: error.name };
  }
  const requires = [];
  const module = { exports: {} };
  globalThis.__nimbusDynamicImport = (_parent, specifier) => { requires.push(`import(${String(specifier)})`); return Promise.resolve({}); };
  globalThis.__trace = (label) => requires.push(`trace:${label}`);
  let threw = null;
  const log = console.log;
  console.log = () => {};
  try {
    const returned = holder.exports(Function).call(module.exports, module.exports, (s) => {
      requires.push(s);
      if (dependencies === null) return anything();
      assert.ok(Object.hasOwn(dependencies, s), `the fixture supplies ${s}`);
      return dependencies[s];
    }, module, '/app/x.js', '/app');
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
    ...(dependencies === null ? {} : { values: exported }),
  };
}

const loaderOf = (name) => (/\.tsx$/.test(name) ? 'tsx' : /\.[mc]?ts$/.test(name) ? 'ts' : /\.jsx$/.test(name) ? 'jsx' : 'js');
function refusal(error, map = null) {
  assert.ok(error instanceof Error);
  assert.ok(Array.isArray(error.errors));
  assert.ok(error.errors.length > 0);
  return {
    refused: true,
    kind: error.constructor.name,
    locations: error.errors.map(({ location }) => {
      if (location === null) return null;
      assert.ok(Number.isInteger(location.line) && location.line > 0);
      assert.ok(Number.isInteger(location.column) && location.column >= 0);
      return map === null ? [location.line, location.column] : originalPosition(map, location.line, location.column);
    }),
  };
}

const outcomes = {
  async commonjs(engine, name, source) {
    const url = `file:///app/${name}`;
    try {
      const { code } = await runTransformRequest(engine, source, { loader: loaderOf(name), format: 'cjs', dynamicImportParent: url }, runtime);
      return await observe(code);
    } catch (error) {
      return refusal(error);
    }
  },
  async browser(engine, name, source) {
    const define = { 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false', 'import.meta.env.MODE': '"development"', 'import.meta.env.SSR': 'false', 'process.env.NODE_ENV': '"development"', global: 'globalThis', 'import.meta.env.BASE_URL': '"/"' };
    let code;
    try {
      ({ code } = await engine.transform(source, { loader: loaderOf(name) === 'js' ? 'ts' : loaderOf(name), format: 'esm', target: 'esnext', jsx: 'automatic', define, sourcemap: 'inline', supported: { 'dynamic-import': false, 'import-meta': false } }));
    } catch (error) {
      return refusal(error);
    }
    const comments = [];
    const tokens = [...tokenizer(code, { ecmaVersion: 'latest', allowHashBang: true, locations: true, onComment: comments })];
    const mapUrl = comments.flatMap(({ value }) => [...value.matchAll(/[#@]\s*sourceMappingURL\s*=\s*(\S+)/g)]).at(-1)?.[1];
    assert.equal(new URL(mapUrl).protocol, 'data:', `${name}: the browser map is inline`);
    const map = await (await fetch(mapUrl)).json();
    assert.equal(map.version, 3);
    if (name === 'destructure.mjs') {
      const token = tokens.find(({ type, value }) => type.label === 'name' && value === 'obj');
      assert.ok(token, 'the transformed module retains the source binding');
      assert.deepEqual(originalPosition(map, token.loc.start.line, token.loc.start.column), [1, source.indexOf('obj')],
        'the browser map points the emitted binding back to its source position');
      assert.ok(map.sourcesContent.includes(source), 'the map carries the source as written');
    }
    // One engine reads both outputs as CommonJS, so only the first pass differs.
    try {
      const { code: cjs } = await esbuild.transform(code, { loader: 'js', format: 'cjs', supported: { 'dynamic-import': true, 'import-meta': true } });
      return await observe(cjs);
    } catch (error) {
      return { ...refusal(error, map), reread: true };
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
  const transform = async (engine, name, source) => {
    let outcome;
    try {
      outcome = await runTransformRequest(engine, source, { loader: 'js', format: 'cjs', dynamicImportParent: `file:///app/${name}` }, runtime);
    } catch (error) {
      // The transform facet's own mapping (facets/oxc-transform.ts OXC_FACET_BODY).
      outcome = error && error.stackExhausted === true ? { error: String(error.message), stackExhausted: true } : { error: String(error.message) };
    }
    return outcome;
  };
  let viaOxc = 0;
  let viaEsbuild = 0;
  for (const [name, source] of Object.entries(deep)) {
    const expected = await outcomes.commonjs(esbuild, name, source);
    let outcome = await transform(oxcEngine, name, source);
    if (outcome.stackExhausted === true) {
      viaEsbuild++;
      outcome = await transform(esbuild, name, source);
    } else viaOxc++;
    const actual = 'error' in outcome ? { refused: true } : await observe(outcome.code);
    assert.deepEqual(actual, expected, `${name}: ${JSON.stringify(actual).slice(0, 300)}`);
  }
  assert.ok(viaOxc > 0 && viaEsbuild > 0, `both routes taken: ${viaOxc} by Oxc, ${viaEsbuild} by esbuild`);
  console.log(`  ok  ${Object.keys(deep).length} deep modules equal: ${viaOxc} by Oxc, ${viaEsbuild} past its stack by esbuild`);
}

// ── Imported calls and tags preserve ES module receivers and arguments ─────
{
  const calls = [];
  const callable = (label, result) => function (...args) {
    calls.push({ label, receiver: this, args });
    return result;
  };
  const tag = (label, result) => function (strings, ...substitutions) {
    calls.push({ label, receiver: this, strings: [...strings], raw: [...strings.raw], substitutions });
    return result;
  };
  const object = { method: callable('method', 'method-result') };
  const source = `
    import call from 'default-call';
    import { call as namedCall } from 'named-call';
    import tag from 'default-tag';
    import { tag as namedTag, object } from 'named-tag';
    export const called = [call('default', 7), namedCall('named', { count: 2 })];
    export const tagged = [tag\`line\\n\${3}!\`, namedTag\`named\${{ value: 4 }}end\`];
    export const method = object.method('method', 5);
    export default 11;
  `;
  const { code } = await runTransformRequest(oxcEngine, source,
    { loader: 'js', format: 'cjs', dynamicImportParent: 'file:///app/calls.mjs' }, runtime);
  const observed = await observe(code, {
    'default-call': callable('default-call', 'default-result'),
    'named-call': { call: callable('named-call', 'named-result') },
    'default-tag': tag('default-tag', 'default-tag-result'),
    'named-tag': { tag: tag('named-tag', 'named-tag-result'), object },
  });
  assert.equal(observed.threw, null);
  assert.equal(observed.esModule, true);
  assert.deepEqual(observed.requires, ['default-call', 'named-call', 'default-tag', 'named-tag']);
  assert.deepEqual(observed.values, {
    called: ['default-result', 'named-result'], tagged: ['default-tag-result', 'named-tag-result'],
    method: 'method-result', default: 11,
  });
  assert.deepEqual(calls, [
    { label: 'default-call', receiver: undefined, args: ['default', 7] },
    { label: 'named-call', receiver: undefined, args: ['named', { count: 2 }] },
    { label: 'default-tag', receiver: undefined, strings: ['line\n', '!'], raw: ['line\\n', '!'], substitutions: [3] },
    { label: 'named-tag', receiver: undefined, strings: ['named', 'end'], raw: ['named', 'end'], substitutions: [{ value: 4 }] },
    { label: 'method', receiver: object, args: ['method', 5] },
  ]);
  assert.equal(calls[4].receiver, object, 'the method receives the imported object itself');
  console.log('  ok  imported calls and tags have no receiver; an imported object keeps its method receiver');
}

// ── The server classifier consumes the real emitted CommonJS ───────────────
{
  const { code } = await runTransformRequest(oxcEngine, `
    import program from 'commander';
    program.command('serve').action(() => require('node:http').createServer().listen(3000));
    program.command('build').action(() => console.log('built'));
    program.parse(process.argv);
  `, { loader: 'js', format: 'cjs', dynamicImportParent: 'file:///app/cli.mjs' }, runtime);
  const host = { resolve: async () => null, read: async () => null };
  for (const [args, expected] of [[['serve'], true], [['build'], false], [['serve', '--help'], false], [['--help'], false]]) {
    const launches = await programLaunchesServer({
      source: code, path: '/app/cli.cjs', dir: '/app', packageRoot: '/app', argv: ['/usr/bin/node', '/app/cli.cjs', ...args],
    }, host);
    assert.equal(launches, expected, `the transformed CLI classifies ${args.join(' ')}`);
  }
  console.log('  ok  the server classifier distinguishes serve, build and help in transformed CommonJS');
}

// ── Refusals carry structured locations and reject unsupported options ─────
{
  for (const [source, location] of [['await 1; export {};', [1, 0]], ['let a = ;', [1, 8]]]) {
    await assert.rejects(oxcEngine.transform(source, { loader: 'js', format: 'cjs' }), (error) => {
      assert.deepEqual(refusal(error), { refused: true, kind: 'Error', locations: [location] });
      assert.equal(error.errors[0].location.lineText, source);
      return true;
    });
  }
  await assert.rejects(oxcEngine.transform('x', { loader: 'css' }), Error);
  await assert.rejects(oxcEngine.transform('x', { target: 'es2020' }), Error);
  await assert.rejects(oxcEngine.transform('<C />', { loader: 'jsx', jsx: 'preserve', format: 'cjs' }), Error);
  console.log('  ok  refusals locate invalid source, and unsupported options are refused, not ignored');
}

await stopEsbuildEngine();
console.log('transform-differential OK');
