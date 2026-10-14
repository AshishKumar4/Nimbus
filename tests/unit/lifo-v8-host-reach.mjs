#!/usr/bin/env bun
// The shell's built-in node gives a program the engine's own v8 (its
// serialize, deserialize and heap statistics are the engine's), but a v8
// function that would reach past the program, to the host's files or the
// engine's flags (a heap snapshot file, coverage, V8 flags), refuses as an
// unavailable feature, naming itself, and does nothing.
//
// Red before: lifo's v8 was a stub whose serialize returned no bytes and
// whose deserialize returned undefined, and it had none of these names.

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { createModuleMap } from '../../packages/core/src/substrate/lifo/node-compat/index.ts';

const v8 = createModuleMap({
  filesystem: () => null,
  cwd: '/',
  env: {},
  stdout: { write() {} },
  stderr: { write() {} },
  argv: [],
  filename: '/x.js',
  dirname: '/',
  signal: new AbortController().signal,
}).v8();

const value = { a: [1, new Map([[1, 2]]), new Date(0)] };
assert.deepEqual(v8.deserialize(v8.serialize(value)), value, 'serialize and deserialize are the engine\'s');
assert.ok(v8.getHeapStatistics().heap_size_limit > 0, 'heap statistics are the engine\'s');

const before = readdirSync('.');
for (const name of ['writeHeapSnapshot', 'setFlagsFromString', 'setHeapSnapshotNearHeapLimit', 'takeCoverage', 'stopCoverage']) {
  assert.throws(() => v8[name]('x'), {
    name: 'TypeError',
    code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
    message: `The feature v8.${name} is unavailable on the current platform, which is being used to run Node.js`,
  });
}
assert.deepEqual(readdirSync('.'), before, 'no file was written');
assert.equal(existsSync('x'), false);
console.log('lifo-v8-host-reach: ok');
