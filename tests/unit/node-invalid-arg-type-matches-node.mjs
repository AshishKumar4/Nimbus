// Node's ERR_INVALID_ARG_TYPE as the runtime words it (core
// _shared/node-error.ts invalidArgType and determineSpecificType, as the
// shims declare them, NODE_ERROR_PREAMBLE), against Node's own message for
// the same name, expectation and value: host Node the oracle, its public
// functions that validate with each kind of expectation (a type, a class, a
// type or classes or something else, a description) given every kind of
// value. Before, seven copies described the value, and drifted: a string
// shown unquoted, a type named by typeof alone, an object with no
// constructor printed as "[object Object]".

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { NODE_ERROR_PREAMBLE } from '../../packages/worker/src/loaders/generated-workers.ts';

const PROGRAM = `
${NODE_ERROR_PREAMBLE}
const util = require('node:util');
useNodeErrorInspect(util.inspect);
const { Writable } = require('node:stream');
const quiet = new (require('node:console').Console)({ stdout: new Writable({ write(chunk, encoding, callback) { callback(); } }) });
const values = [
  undefined, null, 0, -0, NaN, Infinity, -Infinity, 5, 1.5, 10n, true, false, Symbol('s'), Symbol(),
  '', 'short', "it's", 'x'.repeat(40), "a'".repeat(20), function named() {}, () => {}, class K {},
  {}, [], new Map(), Object.create(null), Object.assign(Object.create(null), { a: 1 }), new (class Q {})(),
  Object.create(Object.create(null)), { constructor: undefined },
];
// [name, expected, how Node throws it for a value]
const checks = [
  ['original', 'function', (v) => util.promisify(v)],
  ['first argument', ['string', 'Buffer', 'ArrayBuffer', 'Array', 'Array-like Object'], (v) => Buffer.from(v)],
  ['options.exclude', ['function', 'string[]'], (v) => require('node:fs').globSync('*', { exclude: v })],
  ['options.x.type', "('string|boolean')", (v) => util.parseArgs({ args: [], options: { x: { type: v } } })],
  ['warning', ['string', 'Error'], (v) => process.emitWarning(v)],
  ['properties', 'Array', (v) => quiet.table([], v)],
];
const differences = [];
let compared = 0;
for (const [name, expected, run] of checks) {
  for (const value of values) {
    let node;
    try { run(value); continue; } catch (e) { node = e; }
    if (node.code !== 'ERR_INVALID_ARG_TYPE') continue;
    const ours = invalidArgType(name, expected, value);
    compared++;
    const shape = (e) => ({ message: e.message, code: e.code, name: e.name, ctor: e.constructor.name, keys: Object.keys(e), header: String(e.stack).split('\\n')[0] });
    if (JSON.stringify(shape(ours)) !== JSON.stringify(shape(node))) differences.push({ name, value: util.inspect(value), ours: shape(ours), node: shape(node) });
  }
}
console.log(JSON.stringify({ compared, differences }));
`;

const ran = spawnSync('node', ['--no-warnings', '-e', PROGRAM], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH } });
assert.equal(ran.status, 0, ran.stderr);
const { compared, differences } = JSON.parse(ran.stdout.trim().split('\n').at(-1));
assert.ok(compared >= 100, `every expectation throws for most values (${compared})`);
assert.deepEqual(differences, [], `Node words each as the runtime does:\n${differences.map((d) => JSON.stringify(d)).join('\n')}`);
console.log(`node-invalid-arg-type-matches-node: ${compared} messages as Node words them`);
