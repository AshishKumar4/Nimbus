#!/usr/bin/env bun
/**
 * The one ES-module-to-CommonJS emitter (async-module-lowering.ts
 * emitCommonJs over readEsmRecords), in both bodies, against esbuild's own
 * `format: 'cjs'` output for the same module: the exports object a require
 * returns has the same names in the same order, each an enumerable getter
 * with the same value, `__esModule` a non-enumerable true, a default import
 * through `__esModule` interop, the module's own names and an earlier
 * `export *`'s winning over a later one's. Then the bounded bundle rewrite
 * (rewriteBundledEsmToCjs), which builds its records from the declarations
 * it finds, gives the same exports. And what only the lowering does: a
 * binding the body assigns after its getter is installed reads as assigned.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { emitCommonJs, readEsmRecords } from '../../packages/core/src/runtime/async-module-lowering.ts';
import { rewriteBundledEsmToCjs } from '../../packages/core/src/runtime/esbuild-service.ts';

/** Modules the cases import, as CommonJS: one marked __esModule, two plain. */
function dependencies() {
  const esm = { default: 'D', n: 'N', o: 'O' };
  Object.defineProperty(esm, '__esModule', { value: true });
  return { esm, plain: { n: 'N2', p: 'P2', default: 'D2' }, fn: Object.assign(function callable() { return 'called'; }, { tag: 'T' }) };
}

/** Run CommonJS `code` as a module; the value require() would return. */
async function run(code) {
  const deps = dependencies();
  const require = (name) => {
    if (!(name in deps)) throw new Error(`no module ${name}`);
    return deps[name];
  };
  require.resolve = (name) => name;
  const module = { exports: {}, require };
  const done = new Function('module', 'exports', 'require', code)(module, module.exports, require);
  if (done && typeof done.then === 'function') await done;
  return module.exports;
}

/** What a consumer can observe of an exports object. */
function shape(exports) {
  const esModule = Object.getOwnPropertyDescriptor(exports, '__esModule');
  return {
    keys: Object.keys(exports),
    esModule: esModule ? { value: esModule.value, enumerable: esModule.enumerable } : null,
    entries: Object.keys(exports).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(exports, key);
      const value = exports[key];
      return [key, typeof descriptor.get, descriptor.enumerable, typeof value === 'function' ? `fn:${value.name}` : value];
    }),
  };
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
  'a re-export, a namespace re-export and a default function': `
    export { n as x, default as y } from 'esm';
    export * as all from 'plain';
    export default function named() {}`,
  "export *: the module's own names and the first star win": `
    export * from 'esm';
    export * from 'plain';
    export const n = 'own';`,
  'an anonymous default class': 'export default class {}',
};

for (const [label, source] of Object.entries(CASES)) {
  // esbuild names an anonymous default after its file; the language, and
  // Node, name it `default`.
  const expected = JSON.parse(JSON.stringify(shape(await run(esbuild.transformSync(source, { format: 'cjs', loader: 'js' }).code)))
    .replaceAll('"fn:stdin_default"', '"fn:default"'));
  for (const body of ['sync', 'async']) {
    const actual = JSON.parse(JSON.stringify(shape(await run(emitCommonJs(source, readEsmRecords(source), { body })))));
    assert.deepEqual(actual, expected, `${label} (${body} body)`);
  }
}

// The bounded bundle rewrite reads the declarations a bundle prints and
// emits through the same emitter.
{
  const bundle = [
    "import d, { n } from 'esm';",
    'var helper = () => d + n;',
    'var value = helper();',
    'export { helper, value as computed };',
    'export default value;',
  ].join('\n');
  const expected = shape(await run(esbuild.transformSync(bundle, { format: 'cjs', loader: 'js' }).code));
  for (const factory of [false, true]) {
    const rewritten = rewriteBundledEsmToCjs(bundle, 'file:///bundle.js', factory);
    assert.ok(rewritten, 'the bundle takes the bounded path');
    const code = factory
      ? `return (function () { ${rewritten.code} }).call(undefined, undefined, require, module);`
      : rewritten.code;
    assert.deepEqual(shape(await run(code)), expected, `bundle rewrite (module factory: ${factory})`);
  }
}

// A getter installed before the body reads what the body assigns after an
// await: esbuild cannot emit CommonJS for this at all.
{
  const source = "export let db; db = await Promise.resolve('connected'); export const ready = true;";
  const exports = await run(emitCommonJs(source, readEsmRecords(source), { body: 'async' }));
  assert.deepEqual({ ...exports }, { db: 'connected', ready: true });
}

// Generated names never collide with the module's, and a module's own
// binding named Object does not reach the generated code.
{
  const source = "import Object from 'plain'; const __nimbus_m0 = 'mine'; export const seen = [Object.p, __nimbus_m0];";
  for (const body of ['sync', 'async']) {
    const exports = await run(emitCommonJs(source, readEsmRecords(source), { body }));
    assert.deepEqual(exports.seen, ['P2', 'mine'], `${body} body`);
  }
}

// String export names, "*" among them, against real Node: a name "*" is a
// name like any other, never the namespace, in an import, a re-export and
// a re-export of the namespace beside it.
{
  const dir = mkdtempSync(join(tmpdir(), 'esm-to-cjs-'));
  try {
    writeFileSync(join(dir, 'dep.mjs'), 'const star = "star-value"; const d = "D"; export { star as "*", d as default }; export const a = 1;\n');
    const MODULES = {
      'import { "*" as value }': 'import { "*" as value } from "./dep.mjs"; await 0; export { value };',
      'export { "*" as again } from': 'export { "*" as again } from "./dep.mjs"; export const own = 1;',
      'export * as ns beside a "*" re-export': 'export * as ns from "./dep.mjs"; export { "*" as star, default as d } from "./dep.mjs";',
      'import * as and import { "*" as }': 'import * as all from "./dep.mjs"; import { "*" as one } from "./dep.mjs"; export const seen = [Object.keys(all).sort(), one];',
      // The shape a bundle prints, which the bounded rewrite takes.
      'a bundle importing "*"': 'import * as all from "./dep.mjs"; import { "*" as one } from "./dep.mjs"; var seen = [Object.keys(all).sort(), one]; export { seen };',
    };
    /** A module's exports as plain data: a namespace's sorted entries, so Node's and ours compare. */
    const plain = (value) => value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, plain(value[k])]))
      : value;
    const nodeRun = spawnSync('node', ['--input-type=module', '-e', `
      import { writeFileSync } from 'node:fs';
      const out = {};
      out.dep = { ...(await import(${JSON.stringify(join(dir, 'dep.mjs'))})) };
      for (const [label, source] of Object.entries(${JSON.stringify(MODULES)})) {
        const file = ${JSON.stringify(dir)} + '/m' + Object.keys(out).length + '.mjs';
        writeFileSync(file, source);
        out[label] = await import(file);
      }
      const plain = ${plain.toString()};
      process.stdout.write(JSON.stringify(plain(out)));
    `], { encoding: 'utf8' });
    assert.equal(nodeRun.status, 0, nodeRun.stderr);
    const node = JSON.parse(nodeRun.stdout);
    const dep = Object.defineProperty({ ...node.dep }, '__esModule', { value: true });
    const bundled = [];
    for (const [label, source] of Object.entries(MODULES)) {
      const lowerings = { sync: () => emitCommonJs(source, readEsmRecords(source), { body: 'sync' }), async: () => emitCommonJs(source, readEsmRecords(source), { body: 'async' }) };
      if (source.includes('await')) delete lowerings.sync;
      const rewritten = rewriteBundledEsmToCjs(source, 'file:///m.mjs');
      if (rewritten) {
        lowerings.bundle = () => rewritten.code;
        bundled.push(label);
      }
      for (const [body, lower] of Object.entries(lowerings)) {
        const require = (name) => { assert.equal(name, './dep.mjs'); return dep; };
        const module = { exports: {}, require };
        const done = new Function('module', 'exports', 'require', lower())(module, module.exports, require);
        if (done && typeof done.then === 'function') await done;
        assert.deepEqual(plain(module.exports), node[label], `${label} (${body}) exports what Node's module does`);
      }
    }
    assert.deepEqual(bundled, ['a bundle importing "*"'], 'the bundle shape takes the bounded rewrite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await esbuild.stop?.();
console.log(`esm-to-cjs: ${Object.keys(CASES).length} modules lower as esbuild's CommonJS does, in both bodies and the bundle rewrite`);
