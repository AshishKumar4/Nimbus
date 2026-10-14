#!/usr/bin/env bun

// The node-compat `assert` is the engine's own (X3e): its equal and
// notEqual are `==` with Node's both-sides-NaN case, end to end through the
// module map. (lifo's handwritten `==` engine and its operator matrix are
// retired with it.)

import assert from 'node:assert/strict';
import { createModuleMap } from '../../packages/core/src/substrate/lifo/node-compat/index.ts';

const nodeAssert = createModuleMap({
  filesystem: () => null,
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

console.log('node-compat loose equality: assert.equal and notEqual are ==, NaN equal to NaN');
