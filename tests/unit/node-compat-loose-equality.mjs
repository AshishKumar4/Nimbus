#!/usr/bin/env bun

// The node-compat `assert.equal` shim is specified against `==`, so the
// coercions it carries are checked against the operator itself over a value
// matrix, plus the both-sides-NaN case Node folded in at v14.

import assert from 'node:assert/strict';
import {
  assertEqualHolds,
  looseEqual,
} from '../../packages/core/src/substrate/lifo/node-compat/loose-equality.ts';
import { createModuleMap } from '../../packages/core/src/substrate/lifo/node-compat/index.ts';

const boxedTrue = new Boolean(true);
const dateEpoch = new Date(0);
const toPrimitiveObject = { [Symbol.toPrimitive]: (hint) => (hint === 'number' ? 7 : '7') };

const values = [
  undefined, null,
  true, false,
  0, -0, 1, 1.5, -1, NaN, Infinity, -Infinity,
  '', ' ', '0', '1', '1.5', 'NaN', 'abc', '0x10', '  12  ',
  0n, 1n, 12n, -1n,
  Symbol.iterator,
  {}, [], [0], [1], ['1'], (() => 1),
  boxedTrue, dateEpoch, toPrimitiveObject,
  new Number(1), new String('1'),
];

const label = (value) => (typeof value === 'symbol' ? 'Symbol()' : `${typeof value}:${String(value)}`);

let compared = 0;
for (const a of values) {
  for (const b of values) {
    let expected;
    try {
      expected = a == b; // The oracle: the operator being reproduced.
    } catch {
      continue; // Symbol coercion throws on both sides; skip those pairs.
    }
    let actual;
    try {
      actual = looseEqual(a, b);
    } catch (error) {
      assert.fail(`looseEqual(${label(a)}, ${label(b)}) threw: ${error.message}`);
    }
    assert.equal(
      actual,
      expected,
      `looseEqual(${label(a)}, ${label(b)}) = ${actual}, operator says ${expected}`,
    );
    compared++;
  }
}
assert.ok(compared > 1000, `expected a wide matrix, compared ${compared} pairs`);

// Same-reference objects and same-valued-but-distinct objects.
const shared = { v: 1 };
assert.equal(looseEqual(shared, shared), true);
assert.equal(looseEqual({ v: 1 }, { v: 1 }), false);

// Node's NaN carve-out: `==` says false, `assert.equal` treats it as equal.
assert.equal(looseEqual(NaN, NaN), false);
assert.equal(assertEqualHolds(NaN, NaN), true);
// Non-coercing: Node reaches for Number.isNaN, so the string is not NaN.
assert.equal(assertEqualHolds('NaN', NaN), false);
assert.equal(assertEqualHolds(NaN, 'NaN'), false);

// The shim's assert.equal/notEqual reflect that, end to end.
const nodeAssert = createModuleMap({
  vfs: null,
  cwd: '/',
  env: {},
  stdout: { write() {} },
  stderr: { write() {} },
  argv: [],
  filename: '/x.js',
  dirname: '/',
  signal: new AbortController().signal,
}).assert();

nodeAssert.equal(1, '1');
nodeAssert.equal(NaN, NaN);
nodeAssert.notEqual(1, 2);
nodeAssert.notEqual(NaN, 1);
assert.throws(() => nodeAssert.equal(1, 2));
assert.throws(() => nodeAssert.notEqual(1, '1'));
assert.throws(() => nodeAssert.notEqual(NaN, NaN));
assert.throws(() => nodeAssert.strictEqual(1, '1'));
nodeAssert.notStrictEqual(1, '1');

console.log(`node-compat loose equality: ${compared} operator pairs reproduced`);
