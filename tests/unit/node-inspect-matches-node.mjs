#!/usr/bin/env bun
// The shims' util.inspect is Node v22.22.3's own: lib/internal/util/inspect.js
// over the primordials lib/internal/per_context/primordials.js builds, byte
// for byte (their digests are pinned), given ports of the Node internals they
// import (node-inspect-host.ts).
//
// Here the shims' composition runs in real node, with node's own util as the
// platform, beside node's util.inspect, over values and options of every kind
// inspect.js formats; the two must print the same bytes. The one difference
// the host names is not compared: with customInspect false, a value only
// V8's internals read (a promise's state, an iterator's entries) is
// formatted with none of them. console-format-matches-node-workerd runs the
// same code in workerd, the platform the shims ship on.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EAST_ASIAN_WIDE_RANGES, NODE_INSPECT_SHA256, NODE_INSPECT_SOURCE, NODE_PRIMORDIALS_SHA256, NODE_PRIMORDIALS_SOURCE,
} from '../../packages/worker/src/runtime/node-inspect-source.ts';
import { createNodeInspect } from '../../packages/worker/src/runtime/node-inspect-host.ts';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
assert.equal(sha256(NODE_INSPECT_SOURCE), '2f2f01d7077800f8565d1be2bd1e6800f8ac02759482dc080eb6bc6005d67dd1', 'inspect.js is v22.22.3\'s, byte for byte');
assert.equal(sha256(NODE_INSPECT_SOURCE), NODE_INSPECT_SHA256);
assert.equal(sha256(NODE_PRIMORDIALS_SOURCE), '9e3fe2fe051667172d6ed9d997eee99b3454a7e4ec779dd63c1f19d44b25b1ca', 'primordials.js is v22.22.3\'s, byte for byte');
assert.equal(sha256(NODE_PRIMORDIALS_SOURCE), NODE_PRIMORDIALS_SHA256);

const PROGRAM = String.raw`
const util = require('util');
const wide = __WIDE__.split(',').flatMap((range) => { const [a, b = a] = range.split('-'); return [parseInt(a, 16), parseInt(b, 16)]; });
const port = (__HOST__)({
  util, Buffer, url: require('url'), process, builtinModules: require('module').builtinModules,
  eastAsianWide(code) {
    for (let i = 0; i < wide.length; i += 2) if (code >= wide[i] && code <= wide[i + 1]) return true;
    return false;
  },
  primordialsOf: new Function('primordials', 'globalThis', __PRIMORDIALS__),
  inspectOf: new Function('exports', 'require', 'module', 'process', 'internalBinding', 'primordials', __INSPECT__),
});

const circular = { name: 'c' }; circular.self = circular; circular.list = [circular];
class Point { constructor() { this.x = 1; this.y = 2; } }
class Sub extends Map { extra = true; }
const cause = new TypeError('inner'); cause.stack = 'TypeError: inner\n    at inner (/x.js:1:1)';
const error = new Error('outer', { cause }); error.stack = 'Error: outer\n    at outer (/y.js:2:2)'; error.code = 'E_OUTER';
const aggregate = new AggregateError([new Error('a'), new RangeError('b')], 'many'); aggregate.stack = 'AggregateError: many\n    at z (/z.js:3:3)';
const getters = { get value() { return 1; }, set value(v) {}, get only() { return 2; } };
const rejected = Promise.reject(new Error('no')); rejected.catch(() => {});
const values = [
  { a: 1, b: 'two', c: [1, 2, 3], d: { e: { f: { g: { h: 1 } } } } },
  [1, 'a', null, undefined, true, 10n, Symbol('s')], -0, 0, NaN, Infinity, 1e21, 123456789.123, 'str', "it's", 'a\nb', '',
  new Map([[1, { a: 1 }], ['k', [1, 2]]]), new Set([1, 'x']), new Sub([[1, 2]]), new WeakMap(), new WeakSet(),
  Array.from({ length: 120 }, (_, i) => i), Array.from({ length: 30 }, (_, i) => 'item' + i), [[1, [2, [3, [4, [5]]]]]],
  { long: 'x'.repeat(100), list: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'] },
  circular, new Point(), Point, Sub, Object.create(null), Object.assign(Object.create(null), { a: 1 }),
  { [Symbol('k')]: 3, 'quoted-key': 2, 'a b': 1, valid_id: 0, 1: 'one', __proto__: { inherited: 1 } },
  error, aggregate, new RangeError('plain'), Object.assign(new Error('fields'), { stack: 'Error: fields\n    at f (/f.js:1:1)', extra: [1] }),
  new Date(0), new Date(NaN), /x\/y/gi, function named() {}, async function asyncNamed() {}, function* gen() {}, async function* agen() {}, () => {}, class {},
  new Uint8Array([1, 2, 3]), new Float64Array([0.5, -0]), new BigInt64Array([1n]), Buffer.from('hello'), new ArrayBuffer(4), new DataView(new ArrayBuffer(2)),
  [, 1, , 2, , ], Object.assign([1, 2], { extra: 'x' }), Object.setPrototypeOf([1, 2], null), Object.setPrototypeOf(new Map([[1, 2]]), null),
  new Number(3), new String('ab'), new Boolean(false), Object(10n), Object(Symbol('boxed')),
  Symbol.iterator, Symbol('desc'), Symbol(), 10n, getters, { f() {}, g: function () {}, h: async () => {} },
  { s: '日本語のテキスト', e: '😀👍🏽', mixed: 'ab日本' }, ['日本', '語', 'テキスト', 'abc', 'de', 'f', 'g', 'h'],
  Promise.resolve({ a: 1 }), rejected, new Promise(() => {}), new Map([[1, 2]]).entries(), new Set([1]).values(), [1, 2][Symbol.iterator](),
  new Proxy({ a: 1 }, {}), new Proxy([1, 2], {}), process.env.__NONE__, null, undefined, true,
  new URL('http://user:pw@host:8080/p/a/t/h?query=string#hash'), new URLSearchParams('a=1&b=2'),
  { [util.inspect.custom]: (depth, options, inspect) => 'custom:' + depth + ':' + inspect({ n: 1 }, options) },
  { nested: { [util.inspect.custom]() { return { replaced: true }; } } },
];
const optionSets = [
  {}, { colors: true }, { depth: 0 }, { depth: null }, { showHidden: true }, { compact: false }, { compact: 1 },
  { breakLength: 40 }, { breakLength: Infinity }, { sorted: true }, { getters: true }, { maxArrayLength: 2 },
  { maxStringLength: 4 }, { numericSeparator: true }, { customInspect: false },
];
const internalsOnly = (value) => util.types.isPromise(value) || util.types.isMapIterator(value) || util.types.isSetIterator(value) || util.types.isProxy(value)
  || util.types.isWeakMap(value) || util.types.isWeakSet(value);
const differences = [];
values.forEach((value, i) => {
  for (const options of optionSets) {
    if (options.customInspect === false && internalsOnly(value)) continue;
    const node = util.inspect(value, options);
    const ported = port.inspect(value, options);
    if (node !== ported) differences.push({ value: i, options, node, ported });
  }
});
const formats = [
  ['%s is %d years, %i whole, %f float', 'Bob', 42.5, 42.5, '1.5'], ['%s', { a: 1 }, '%s', Symbol('t')], ['%s', 10n, -0, null],
  ['%o', { a: [1, 2, { b: 3 }], f() {} }], ['%O', { a: [1, 2, { b: 3 }] }], ['%j', { a: 1 }, 'extra'], ['%j', circular],
  ['%c styled', 'color: red'], ['100%', 'done', '%%', '%d'], ['%d %i', 10n, 10n], ['%x %s'], [], [{ a: 1 }, 'x', 3], ['a\nb', { c: 'd\ne' }],
];
for (const args of formats) {
  const node = util.format(...args);
  const ported = port.format(...args);
  if (node !== ported) differences.push({ format: args.map(String), node, ported });
  const nodeColors = util.formatWithOptions({ colors: true }, ...args);
  const portedColors = port.formatWithOptions({ colors: true }, ...args);
  if (nodeColors !== portedColors) differences.push({ formatWithOptions: args.map(String), node: nodeColors, ported: portedColors });
}
for (const text of ['\u001b[31mred\u001b[39m', 'plain']) {
  if (util.stripVTControlCharacters(text) !== port.stripVTControlCharacters(text)) differences.push({ strip: text });
}
console.log(JSON.stringify(differences));
`;

const dir = mkdtempSync(join(tmpdir(), 'node-inspect-'));
let differences;
try {
  const program = PROGRAM
    .replace('__WIDE__', JSON.stringify(EAST_ASIAN_WIDE_RANGES))
    .replace('__HOST__', () => createNodeInspect.toString())
    .replace('__PRIMORDIALS__', () => JSON.stringify(NODE_PRIMORDIALS_SOURCE))
    .replace('__INSPECT__', () => JSON.stringify(NODE_INSPECT_SOURCE));
  writeFileSync(join(dir, 'compare.cjs'), program);
  const { NO_COLOR, FORCE_COLOR, NODE_DISABLE_COLORS, ...env } = process.env;
  const node = spawnSync('node', ['compare.cjs'], { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(node.status, 0, node.stderr);
  differences = JSON.parse(node.stdout.trim().split('\n').at(-1));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
assert.deepEqual(differences, [], `the port prints what node prints:\n${differences.map((d) => JSON.stringify(d).slice(0, 600)).join('\n')}`);
console.log('node-inspect-matches-node: Node\'s inspect.js, as the shims run it, prints what node prints');
