#!/usr/bin/env bun
/**
 * A bundled ES module of 512 KiB and more is lowered to CommonJS in the
 * session (bundle-cell-transform.ts's bounded rewrite) rather than by the
 * transform host; its imports are live bindings there too, as Node's are.
 * The same module runs natively in Node and through prepareBundleCell, and
 * what it reads after its imports' module changes must agree: a read at the
 * top level, in a function, in a function nested in functions (which the
 * bounded reader analyzes and drops as it parses), in a class's getter, in
 * a name a parameter or a block shadows, of an import declared after its
 * use, and a write, which throws.
 * And each scope a construct's parts are evaluated in: a switch's
 * discriminant outside its cases' (which may declare the import's name
 * again), a for loop's head beside its body's, a class's heritage, and a
 * parameter's default outside its function's body.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_ESM_REWRITE_MIN_BYTES, prepareBundleCell } from '../../packages/core/src/runtime/bundle-cell-transform.ts';
import { emitCommonJs, readEsmRecords } from '../../packages/core/src/runtime/async-module-lowering.ts';

const COUNTER = 'export let count = 0; export function increment() { count++; } export let switchInput = 7; export class BaseClass { kind() { return "base"; } }';
const LATE = 'export let lateValue = "early"; export function bump() { lateValue = "late"; }';
const padding = [];
for (let i = 0; padding.join('\n').length < BUNDLED_ESM_REWRITE_MIN_BYTES; i++) {
  padding.push(`function pad${i}(count) { const inner = () => { let lateValue = ${i}; return count + lateValue; }; return inner(); }`);
  if (i % 500 === 0) padding.push(`uses.push(function use${i}() { return [() => () => count][0]()(); });`);
}
// As a bundler emits it: declarations, then one export list.
const BIG = [
  "import { count, increment, switchInput, BaseClass } from './counter.mjs';",
  'const uses = [];',
  'const before = count;',
  ...padding,
  'function read() { return count; }',
  'const nested = () => () => count;',
  'function shadow(count) { return count; }',
  'function blockShadow() { { const count = "block"; return count; } }',
  'class Holder { get value() { return count; } }',
  'function late() { return lateValue; }',
  "function write() { try { count = 5; return 'wrote'; } catch (error) { return error.constructor.name; } }",
  "import { lateValue, bump } from './late.mjs';",
  "function switched() { switch (switchInput) { case 7: let switchInput = 0; return 'seven ' + switchInput; default: return 'other'; } }",
  "function forScopes() { const seen = []; for (let i = count; i < count + 1; i++) { let count = 'body'; seen.push(i, count); } return seen; }",
  "function withDefault(a = count) { var count = 'body'; return [a, count]; }",
  'class Derived extends BaseClass { get base() { return super.kind(); } }',
  'export { before, uses, read, nested, shadow, blockShadow, Holder, late, write, increment, bump, switched, forScopes, withDefault, Derived };',
].join('\n');
assert.ok(BIG.length >= BUNDLED_ESM_REWRITE_MIN_BYTES, `the module is ${BIG.length} bytes`);

const PROGRAM = `
  const before = [m.read(), m.late()];
  m.increment(); m.increment(); m.bump();
  return {
    before: m.before, read: [...before, m.read()], uses: m.uses.map((use) => use()), nested: m.nested()(),
    shadow: m.shadow('param'), blockShadow: m.blockShadow(), holder: new m.Holder().value, late: m.late(), write: m.write(),
    switched: m.switched(), forScopes: m.forScopes(), withDefault: m.withDefault(), derived: new m.Derived().base,
  };
`;

// ── Node ──
const dir = mkdtempSync(join(tmpdir(), 'bundled-esm-live-'));
let node;
try {
  writeFileSync(join(dir, 'counter.mjs'), COUNTER);
  writeFileSync(join(dir, 'late.mjs'), LATE);
  writeFileSync(join(dir, 'big.mjs'), BIG);
  const run = spawnSync('node', ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(join(dir, 'big.mjs'))}); process.stdout.write(JSON.stringify((() => { ${PROGRAM} })()));`,
  ], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(run.status, 0, run.stderr);
  node = JSON.parse(run.stdout);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
assert.deepEqual([node.read, node.late], [[0, 'early', 2], 'late'], 'the oracle: Node reads its imports live');

// ── The bounded rewrite ──
const cell = prepareBundleCell('/home/user/node_modules/pkg/big.mjs', BIG, null, 'node');
assert.ok(cell.outcome && 'code' in cell.outcome, `a module this large is lowered in the session: ${JSON.stringify(Object.keys(cell))}`);
const lowered = (source) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'require', emitCommonJs(source, readEsmRecords(source), { body: 'sync' }))(module, module.exports, () => {
    throw new Error('requires nothing');
  });
  return module.exports;
};
const dependencies = { './counter.mjs': lowered(COUNTER), './late.mjs': lowered(LATE) };
const module = { exports: {} };
// A module factory's arguments: its exports, its require, its module.
new Function(cell.outcome.code)(module.exports, (specifier) => dependencies[specifier], module);
const ours = new Function('m', PROGRAM)(module.exports);
assert.deepEqual(JSON.parse(JSON.stringify(ours)), node, 'the bounded rewrite reads imports live, as Node does');
console.log(`bundled-esm-live-bindings: a ${(BIG.length / 1024).toFixed(0)} KiB module reads its imports as Node does`);
