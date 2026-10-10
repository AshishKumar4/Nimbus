#!/usr/bin/env bun
// esm-interop-differential — an ES module the interpreter runs (a module a
// program produced after its launch began) links as the cell the next launch
// compiles from the same text (async-module-lowering.ts lowerEsModule): both
// link it as runtime/esm-interop.ts says. For each module, the exports
// object a require returns is the same in both: its names in the same order,
// each property's kind and attributes, `__esModule` and the `Module` tag, the
// value of each export, which module object a namespace is, and what a
// default import, a re-export and `export *` read.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { lowerEsModule } from '../../packages/core/src/runtime/async-module-lowering.ts';
import { buildInterpreterFiles } from './lib/interpreter-build.mjs';
import { loadInterpreter } from './lib/interpreter-load.mjs';

/** The modules the cases import, made afresh for each run: what a namespace or a re-export is can then be told apart by identity. */
function dependencies() {
  const esm = Object.defineProperty({ default: 'D', n: 'N', o: 'O' }, '__esModule', { value: true });
  const plain = Object.defineProperty({ n: 'N2', p: 'P2', default: 'D2' }, 'hidden', { value: 'H', enumerable: false });
  const inherits = Object.assign(Object.create({ inherited: 'I' }), { own: 'OWN' });
  const fn = Object.assign(function callable() { return 'called'; }, { tag: 'T' });
  const throwing = Object.defineProperty({}, '__esModule', { get() { throw new Error('marker read'); } });
  return { esm, plain, inherits, fn, throwing };
}

const CASES = {
  'declarations, lists and a default expression': `
    export const a = 1;
    export let b = 2;
    b = 3;
    export function f() { return 'f'; }
    const hidden = 'h';
    export { hidden as renamed, hidden as "string name" };
    export default 40 + 2;`,
  'imports, with default interop': `
    import d, { n as m } from 'esm';
    import plainDefault, { p } from 'plain';
    import callable from 'fn';
    import { default as alsoDefault } from 'plain';
    import 'esm';
    export const values = [d, m, plainDefault.p, p, callable(), alsoDefault.n];`,
  'namespace imports, exported': `
    import * as e from 'esm';
    import * as pl from 'plain';
    import * as f from 'fn';
    export { e, pl, f };`,
  're-exports, a re-exported namespace and a default function': `
    export { n as x, default as y } from 'esm';
    export { default as z, p, hidden } from 'plain';
    export * as all from 'plain';
    export default function named() {}`,
  "export *: the module's own names and the first star win": `
    export * from 'esm';
    export * from 'plain';
    export * from 'inherits';
    export const n = 'own';`,
  'an anonymous default class': 'export default class {}',
  'live bindings': 'export let counter = 0;\nexport function inc() { counter++; }',
  'top-level await': "export const v = await Promise.resolve(42);\nexport { default } from 'esm';",
  // Linking a module that suspends fails as its body would: a rejection, not a throw.
  'a default import whose interop throws, in a module that awaits': "import d from 'throwing';\nawait 0;\nexport const v = d;",
  // A module in a cycle reads an import's namespace before linking made it: a TDZ error.
  'a namespace read back by a module in a cycle': "import * as ns from 'esm';\nimport 'cycle';\nexport function read() { return ns; }",
};

/** A value as the comparison sees it: the dependency it is, a function's name, or an object's own properties. */
function describe(value, deps, depth = 0) {
  for (const [name, dep] of Object.entries(deps)) if (value === dep) return `dep:${name}`;
  if (typeof value === 'function') return `fn:${value.name}`;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 1) return 'object';
  const proto = Object.getPrototypeOf(value);
  return {
    proto: proto === Object.prototype ? 'Object' : proto === null ? null : describe(proto, deps, depth + 1),
    own: Reflect.ownKeys(value).map((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      let read;
      try {
        read = describe(value[key], deps, depth + 1);
      } catch (error) {
        read = `threw ${error.constructor.name}`;
      }
      return [String(key), 'get' in d ? 'get' : 'value', d.enumerable, d.configurable, read];
    }),
  };
}

/** The exports object after one evaluation of `cell`, as a consumer can observe it. */
async function observe(cell) {
  const deps = dependencies();
  const module = { exports: {} };
  let cycle = null;
  const require = (name) => {
    // 'cycle' requires this module back, as a dependency in a cycle with it does, and calls its read().
    if (name === 'cycle') {
      try {
        cycle = { read: describe(module.exports.read(), deps) };
      } catch (error) {
        cycle = { threw: error.constructor.name };
      }
      return {};
    }
    if (!(name in deps)) throw new Error(`no module ${name}`);
    return deps[name];
  };
  let evaluation;
  try {
    const done = cell(module.exports, require, module, '/w/m.mjs', '/w');
    evaluation = done && typeof done.then === 'function'
      ? await done.then(() => 'fulfilled', (error) => `rejected: ${error.message}`)
      : 'returned';
  } catch (error) {
    evaluation = `threw: ${error.message}`;
  }
  const exports = module.exports;
  if (typeof exports.inc === 'function') exports.inc();
  return {
    evaluation,
    cycle,
    sameObject: exports === module.exports,
    exports: describe(exports, deps),
    namespaceOnce: !('all' in exports) || exports.all === exports.all,
  };
}

const { dir, interpreterFile, opsFile } = await buildInterpreterFiles();
try {
  const interpreter = loadInterpreter(interpreterFile, opsFile, () => Promise.reject(new Error('no import here')));
  for (const [label, source] of Object.entries(CASES)) {
    const { code } = lowerEsModule(source, 'node', 'file:///w/m.mjs');
    const lowered = await observe(new Function('exports', 'require', 'module', '__filename', '__dirname', code));
    const interpreted = await observe(interpreter.compileModule('/w/m.mjs', source));
    assert.deepEqual(interpreted, lowered, label);
    assert.ok(lowered.namespaceOnce, `${label}: a re-exported namespace is one object`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`esm-interop-differential: ${Object.keys(CASES).length} modules link alike, lowered and interpreted`);
