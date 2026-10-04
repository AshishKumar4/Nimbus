#!/usr/bin/env bun
// The library host's util.format (console.log's formatter) writes what Node's
// does: a string argument as itself, never inspected (console.log(true,
// 'x') printed 'x' quoted), and Node's specifiers %s %d %i %f %j %o %O %c %%.
// Differential: the same cases through host node's util.format.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { format } from '../../packages/core/src/substrate/lifo/node-compat/util.ts';

const cases = [
  [true, 1, 'undefined'], ['a', 'b'], ['%s', 'a', 'b'], [1, 'x', { y: 2 }],
  ['%i %f %c|', '42.9', '3.5', 'color:red'], ['%d%%', 7], ['%s', 5, 'tail'], [null, 'z'],
  ['%j', { a: [1] }], ['%o', 'str'], ['no specifiers', 'extra', 3], ['%s'],
  ['%i %i %i', '0x10', '12.9px', '-0'], ['%d', '0x10'], ['%f %f', '1.5e3', '-0'],
];
// Arguments JSON cannot carry, each formatted by both sides in its own process.
const special = [`['%d', -0]`, `['%i', -0]`, `['%f', -0]`, `['%i', 1n]`, `['%d', 2n]`, `['%f', 3n]`, `['%i', Symbol('s')]`, `['%d', Symbol('s')]`, `['%f', Symbol('s')]`];
const node = spawnSync('node', ['-e', `const { format } = require('node:util'); process.stdout.write(JSON.stringify(${JSON.stringify(cases)}.map((c) => format(...c))))`], { encoding: 'utf8' });
assert.equal(node.status, 0, node.stderr);
assert.deepEqual(cases.map((c) => format(...c)), JSON.parse(node.stdout));
const nodeSpecial = spawnSync('node', ['-e', `const { format } = require('node:util'); process.stdout.write(JSON.stringify([${special.join(',')}].map((c) => format(...c))))`], { encoding: 'utf8' });
assert.equal(nodeSpecial.status, 0, nodeSpecial.stderr);
assert.deepEqual(special.map((c) => format(...(0, eval)(c))), JSON.parse(nodeSpecial.stdout));
console.log('ok - node-compat-format (util.format as Node writes it)');
