#!/usr/bin/env bun
// The late link module loads after the program replaced built-ins, but
// requires the launch's earlier captures. Its graph keeps import and export
// order, and the lists it hands back remain ordinary arrays. The wasm path
// collector uses the same captures, with root-clamped, insertion-ordered paths.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Script, createContext } from 'node:vm';
import { build } from 'esbuild';
import { bundleInterpreter, PRIMORDIALS_FILE } from '../../packages/worker/scripts/interpreter-bundle.mjs';

if (process.versions.bun) {
  const ran = spawnSync('node', [fileURLToPath(import.meta.url)], { stdio: 'inherit', timeout: 30_000 });
  process.exit(ran.status ?? 1);
}

const bundles = await bundleInterpreter({ start: fileURLToPath(new URL('../../packages/worker/', import.meta.url)) });
const wasm = await build({
  entryPoints: [fileURLToPath(new URL('../../packages/core/src/_shared/relative-wasm-paths.ts', import.meta.url))],
  bundle: true, format: 'iife', globalName: 'wasmPaths', platform: 'neutral', write: false,
  external: ['./primordials.js'],
});
const capture = new Script(`captures = ((module) => { ${bundles.primordials}; return module.exports; })({ exports: {} });`);
const late = new Script(`lateLink = ((module, require) => { ${bundles.esmLate}; return module.exports; })({ exports: {} }, require);`);
const paths = new Script(wasm.outputFiles[0].text);
const setup = new Script(`
const stringify = JSON.stringify;
const define = Reflect.defineProperty;
const prototypeOf = Object.getPrototypeOf;
const arrayPrototype = Array.prototype;
const Failure = Error;
let reads = 0;
const sources = {
  'root.mjs': 'root', 'bridge.mjs': 'bridge', 'leaf.mjs': 'leaf',
  'left.mjs': 'left', 'right.mjs': 'right', 'staged.mjs': 'staged',
  'mystery.mjs': 'mystery', 'wrong.mjs': 'wrong', 'refused.mjs': 'refused',
};
const facts = (names, locals, requests = [], imports = [], stars = [], reexports = []) => ({
  requests,
  bindings: { exports: names, locals, imports, stars, reexports, types: imports.map(() => null) },
});
const request = (specifier) => ({ kind: 'static', specifier });
const analyses = {
  root: facts(['own', 'alias', 'space'], [['own', 'own']],
    ['./bridge.mjs', './left.mjs?x', './right.mjs#x', './common.cjs', './data.json', 'node:fs', './mystery.mjs', './staged.mjs'].map(request),
    [['x'], [], [], ['c'], ['default'], ['readFile'], ['anything'], ['staged']], [1, 2], [['alias', 0, 'x'], ['space', 0, null]]),
  bridge: facts([], [], [request('./leaf.mjs?instance')], [[]], [0]),
  leaf: facts(['x'], [['x', 'x']]),
  left: facts(['clash', 'leftOnly'], [['clash', 'left'], ['leftOnly', 'leftOnly']]),
  right: facts(['clash', 'rightOnly'], [['clash', 'right'], ['rightOnly', 'rightOnly']]),
  staged: facts(['staged'], [['staged', 'staged']]),
  mystery: { requests: [] },
  wrong: facts([], [], [request('./bridge.mjs')], [['absent']]),
  refused: facts([], [], [request('./missing.mjs')], [[]]),
};
const rows = [
  ['module', 'staged.mjs', []], ['module', 'bridge.mjs', [-2]],
  ['commonjs', 'common.cjs', []], ['json', 'data.json', []], ['module', 'refused.mjs', [-3]],
];
const resolutions = {
  './bridge.mjs': { url: 'file:///bridge.mjs', format: 'module', path: '/bridge.mjs' },
  './leaf.mjs?instance': { url: 'file:///leaf.mjs?instance', format: 'module', path: '/leaf.mjs' },
  './left.mjs?x': { url: 'file:///left.mjs?x', format: 'module', path: '/left.mjs' },
  './right.mjs#x': { url: 'file:///right.mjs#x', format: 'module', path: '/right.mjs' },
  './common.cjs': { url: 'file:///common.cjs', format: 'commonjs', path: '/common.cjs' },
  './data.json': { url: 'file:///data.json', format: 'json', path: '/data.json' },
  'node:fs': { url: 'node:fs', format: 'builtin', builtin: 'fs' },
  './mystery.mjs': { url: 'file:///mystery.mjs', format: 'module', path: '/mystery.mjs' },
  './staged.mjs': { url: 'file:///staged.mjs', format: 'module', path: '/staged.mjs' },
};
const refusal = new Failure('staged refusal');
const missing = [{ handedOn: 'file:///leaf.mjs?instance' }, { refusal }];
const host = {
  row(kind, key) {
    for (let i = 0; i < rows.length; i++) if (rows[i][0] === kind && rows[i][1] === key) return i;
    return -1;
  },
  rowKind: (row) => rows[row][0], rowKey: (row) => rows[row][1], rowTargets: (row) => rows[row][2],
  rowBindings: () => '[null,null,["default","c"],["default"]]', rowSettled: () => false,
  missing: (i) => missing[i], source: (key) => sources[key] ?? null,
  fileFormat: () => 'module', loadUnread() { throw new Failure('inherited unread'); },
  resolve(specifier) { if (specifier === './missing.mjs') throw refusal; return resolutions[specifier]; },
  builtinNames: () => ['default', 'readFile'], cjsResolve: () => null,
  exportMessage: (specifier, name) => 'missing ' + name + ' from ' + specifier, decorate: (error) => error,
  requests(_path, text) { reads++; return analyses[text]; },
};
function exercise() {
  const order = lateLink.linkLateGraph(host, 'root.mjs', 'file:///root.mjs', true);
  const conflicts = lateLink.starConflicts(host, 'file:///root.mjs');
  const names = lateLink.namespaceNames(host, 'file:///root.mjs');
  const commonjs = lateLink.commonJsNames(host, 'common.cjs');
  const beforeAdoption = reads;
  lateLink.linkAdopted(host, 1, 'bridge.mjs', 'file:///bridge.mjs');
  const adoptedOnce = beforeAdoption === reads;
  let failure;
  try { lateLink.linkLateGraph(host, 'wrong.mjs', 'file:///wrong.mjs', true); }
  catch (error) { failure = error; }
  let repeated;
  try { lateLink.linkLateGraph(host, 'wrong.mjs', 'file:///wrong.mjs', true); }
  catch (error) { repeated = error; }
  let stagedFailure;
  try { lateLink.linkAdopted(host, 4, 'refused.mjs', 'file:///refused.mjs'); }
  catch (error) { stagedFailure = error; }
  const images = wasmPaths.relativeWasmPaths('load("./a.wasm"); load("../../../b.wasm"); load("./c/../d.wasm"); load("./a.wasm")', '/pkg/lib/index.js');
  const rawBase = wasmPaths.relativeWasmPaths('load("../x.wasm"); load("y.wasm")', '///a//../entry.js');
  return stringify({
    order, conflicts, names, commonjs, images, rawBase,
    ordinary: prototypeOf(order) === arrayPrototype && prototypeOf(conflicts) === arrayPrototype
      && prototypeOf(names) === arrayPrototype && prototypeOf(commonjs) === arrayPrototype && prototypeOf(images) === arrayPrototype,
    adoptedOnce,
    missingName: failure.message, retriedNames: failure !== repeated && lateLink.keptFailure('wrong.mjs') === undefined,
    stagedFailure: stagedFailure === refusal && lateLink.keptFailure('refused.mjs') === refusal,
  });
}
function poison() {
  const thrower = () => { throw new Failure('a replaced built-in was called'); };
  const targets = [];
  const add = (owner, keys) => { for (let i = 0; i < keys.length; i++) targets[targets.length] = [owner, keys[i]]; };
  add(String.prototype, ['startsWith', 'endsWith', 'slice', 'indexOf', 'lastIndexOf', 'includes', 'split', 'replace', 'matchAll']);
  add(Array.prototype, ['push', 'pop', 'join', 'map', 'filter', 'forEach', 'includes', 'slice', 'sort', Symbol.iterator]);
  add(Map.prototype, ['get', 'set', 'has', 'delete', 'forEach', 'keys']);
  add(Set.prototype, ['add', 'has', 'forEach', Symbol.iterator]);
  add(RegExp.prototype, ['exec', 'test', Symbol.matchAll, Symbol.replace]);
  add(Object, ['hasOwn', 'keys', 'defineProperty', 'getOwnPropertyDescriptor']);
  add(Reflect, ['defineProperty', 'get', 'apply']);
  add(JSON, ['parse', 'stringify']);
  add(Math, ['min']);
  add(globalThis, ['Map', 'Set', 'Error', 'SyntaxError', 'URL', 'String', 'Object', 'Array', 'JSON', 'Math', 'decodeURIComponent']);
  for (let i = 0; i < targets.length; i++) define(targets[i][0], targets[i][1], { value: thrower, configurable: true, writable: true });
  for (let i = 0; i < 32; i++) define(arrayPrototype, i, { get: thrower, set: thrower, configurable: true });
  const optional = ['row', 'url', 'names', 'path', 'builtin', 'bindings', 'unread', 'refusal', 'handedOn'];
  for (let i = 0; i < optional.length; i++) define(prototypeOf(arrayPrototype), optional[i], { get: thrower, configurable: true });
}
`);
const run = new Script('outcome = exercise();');
const replace = new Script('poison();');
const answers = [];
for (const replaced of [false, true]) {
  const context = createContext({ URL });
  capture.runInContext(context);
  let requests = 0;
  context.require = (id) => {
    assert.ok(id === `./${PRIMORDIALS_FILE}` || id === './primordials.js', `only the launch captures are required: ${id}`);
    requests++;
    return context.captures;
  };
  paths.runInContext(context);
  setup.runInContext(context);
  if (replaced) replace.runInContext(context);
  const beforeLate = requests;
  late.runInContext(context);
  assert.ok(requests > beforeLate, 'esm-late requires the already evaluated captures');
  run.runInContext(context);
  answers.push(JSON.parse(context.outcome));
}
assert.deepEqual(answers[1], answers[0], 'late loading, linking and wasm paths answer alike after replacement');
assert.deepEqual(answers[0], {
  order: [1, 0], conflicts: ['clash'], names: ['own', 'alias', 'space', 'leftOnly', 'rightOnly'], commonjs: ['default', 'c'],
  images: ['pkg/lib/a.wasm', 'b.wasm', 'pkg/lib/d.wasm'], rawBase: ['a//x.wasm', 'a//../y.wasm'],
  ordinary: true, adoptedOnce: true, missingName: 'missing absent from ./bridge.mjs', retriedNames: true, stagedFailure: true,
});
console.log('esm-late-primordials: late evaluation uses the launch captures; graph order, ordinary arrays and wasm paths survive replacement');
