#!/usr/bin/env bun
// runtime-code-identity — the guest and the supervisor name a piece of
// runtime code alike and charge it alike (commonjs-cell.ts, RUNTIME CODE).
//
// The supervisor stages learned code as gen/<runtimeCodeKey>.js, and the
// guest looks it up by the key it computes itself: a key the two sides
// compute differently is code the next launch carries and never uses. The
// guest's ledger admits code by runtimeCodeCharge against
// RUNTIME_CODE_MAX_BYTES; the supervisor keeps what it learns by the same
// charge.
import assert from 'node:assert/strict';
import {
  COMMONJS_CELL_IMPORTS, COMMONJS_CELL_RUNTIME_SOURCE, RUNTIME_CODE_MAX_BYTES, RUNTIME_INTERPRETER_PRIMORDIALS_MODULE,
  RUNTIME_WASM_MAX_BYTES, runtimeCodeCharge, runtimeCodeKey, runtimeCodeModuleName,
} from '../../packages/core/src/_shared/commonjs-cell.ts';
import { importModuleSet } from './lib/module-map-bundle.mjs';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';

/** A launch's runtime, carrying `staged` (each entry's gen/ module answering its own label). */
async function launch(staged = []) {
  const modules = {
    'main.js': `${COMMONJS_CELL_IMPORTS}
const __NIMBUS_CODE_CELLS = [];
const __NIMBUS_RUNTIME_CODE = ${JSON.stringify(staged.map(([entry]) => runtimeCodeKey(entry)))};
${COMMONJS_CELL_RUNTIME_SOURCE}
export const flush = __nimbusFlushRuntimeCode;`,
    [RUNTIME_INTERPRETER_PRIMORDIALS_MODULE]: { cjs: nodeFacetSources('').interpreterPrimordials },
  };
  for (const [entry, label] of staged) {
    modules[runtimeCodeModuleName(runtimeCodeKey(entry))] = { cjs: `module.exports = function () { return ${JSON.stringify(label)}; };` };
  }
  const { flush } = await importModuleSet(modules, 'main.js');
  return { runtime: globalThis.__nimbusRuntimeCode, flush };
}

// ── the guest finds what the supervisor staged under the supervisor's key ──
{
  const fn = { kind: 'function', params: ['a', 'b'], body: 'return a + b' };
  const asyncFn = { kind: 'async', params: [], body: 'return "\\u2028 é"' };
  const expression = { kind: 'expression', code: '({ answer: 42 })' };
  const module = { kind: 'module', path: 'home/user/app/.vite-temp/config.timestamp-1.mjs', text: 'export default "é";\n' };
  const inline = { kind: 'module', path: 'data:text/javascript,export%20default%201', text: 'export default 1' };
  const { runtime } = await launch([
    [fn, 'staged function'], [asyncFn, 'staged async'], [expression, 'staged expression'],
    [module, 'staged module'], [inline, 'staged inline module'],
  ]);
  globalThis.__nimbusCodeOrigin = () => ({ Function });
  const origin = { import: undefined, Function };
  assert.equal(runtime.compileFunction(fn.kind, fn.params, fn.body, origin), 'staged function');
  assert.equal(runtime.compileFunction(asyncFn.kind, asyncFn.params, asyncFn.body, origin), 'staged async');
  assert.equal(runtime.compileExpression(expression.code, origin), 'staged expression');
  assert.equal(runtime.compileModule(`/${module.path}`, module.text), 'staged module');
  assert.equal(runtime.compileModule(inline.path, inline.text), 'staged inline module');
  delete globalThis.__nimbusCodeOrigin;
  console.log('  [1] the guest finds staged constructor, expression and module code by the supervisor\'s key');
}

// ── the guest's ledger admits exactly what the supervisor's charge allows ──
{
  // Images of 3q bytes are 4q characters of base64; eight such fill the ledger to the byte.
  const count = 8;
  const images = (last) => {
    const quads = (RUNTIME_CODE_MAX_BYTES - count * runtimeCodeCharge({ kind: 'wasm', bytes: '' })) / 4;
    const each = Math.floor(quads / count);
    return Array.from({ length: count }, (_, i) => new Uint8Array(3 * (i < count - 1 ? each : quads - each * (count - 1) + last)).fill(i + 1));
  };
  const base64 = (bytes) => Buffer.from(bytes).toString('base64');
  const exact = images(0);
  assert.ok(exact.every((bytes) => bytes.byteLength <= RUNTIME_WASM_MAX_BYTES), 'the premise: every image is under the wasm limit');
  assert.equal(exact.reduce((sum, bytes) => sum + runtimeCodeCharge({ kind: 'wasm', bytes: base64(bytes) }), 0), RUNTIME_CODE_MAX_BYTES,
    'the premise: the images are charged the whole ledger');

  const full = await launch();
  assert.deepEqual(exact.map((bytes) => full.runtime.recordWasm(bytes)), Array(count).fill(true), 'a ledger charged exactly its limit holds all of it');
  const reports = [];
  await full.flush({ async reportRuntimeCode(entries) { reports.push(...entries); } });
  assert.deepEqual(reports.map((entry) => entry.bytes), exact.map(base64), 'and reports each image once');

  const over = await launch();
  assert.deepEqual(images(1).map((bytes) => over.runtime.recordWasm(bytes)), [...Array(count - 1).fill(true), false],
    'four characters over the limit, the last image is not recorded');
  console.log('  [2] the guest charges what the supervisor charges');
}

console.log('runtime-code-identity OK');
