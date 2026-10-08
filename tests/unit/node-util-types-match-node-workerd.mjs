// @serial
// util.types as a session's `node` program sees it, against host Node
// 22.22.3's: every function Node has, and what each answers for values that
// only a brand check tells apart (a proxy, an object that inherits a Date's
// or an Error's prototype, iterators, boxed primitives).
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTerminal, splitScenarioOutput, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/util-types';
const PROGRAM = String.raw`
const types = require('util').types;
const revocable = Proxy.revocable({}, {});
revocable.revoke();
const values = {
  proxy: new Proxy({}, {}),
  functionProxy: new Proxy(function () {}, {}),
  revokedProxy: revocable.proxy,
  date: new Date(0),
  dateLike: Object.create(Date.prototype),
  regExp: /x/,
  regExpLike: Object.create(RegExp.prototype),
  error: new TypeError('x'),
  errorLike: Object.create(Error.prototype),
  asyncFunction: async function () {},
  generatorFunction: function* () {},
  asyncGeneratorFunction: async function* () {},
  generator: (function* () {})(),
  arguments: (function () { return arguments; })(),
  map: new Map(),
  set: new Set(),
  mapIterator: new Map().keys(),
  setIterator: new Set().values(),
  weakMap: new WeakMap(),
  weakSet: new WeakSet(),
  arrayBuffer: new ArrayBuffer(1),
  dataView: new DataView(new ArrayBuffer(1)),
  uint8Array: new Uint8Array(1),
  float64Array: new Float64Array(1),
  bigInt64Array: new BigInt64Array(1),
  buffer: Buffer.alloc(1),
  number: new Number(1),
  string: new String(''),
  boolean: new Boolean(false),
  symbol: Object(Symbol('s')),
  bigint: Object(1n),
  promise: Promise.resolve(),
  thenable: { then() {} },
  object: {},
  primitive: 1,
};
const out = {};
for (const name of Object.keys(types).sort()) {
  out[name] = Object.keys(values).flatMap((key) => {
    try { return types[name](values[key]) ? [key] : []; } catch { return ['throws ' + key]; }
  });
}
console.log('TYPES ' + JSON.stringify(out));
`;
const typesOf = (text) => {
  const line = text.split('\n').find((l) => l.startsWith('TYPES '));
  assert.ok(line, text.slice(-2000));
  return JSON.parse(line.slice('TYPES '.length));
};

const host = mkdtempSync(join(tmpdir(), 'node-util-types-'));
process.on('exit', () => rmSync(host, { recursive: true, force: true }));
writeFileSync(join(host, 'types.cjs'), PROGRAM);
const ran = spawnSync('node', ['types.cjs'], { cwd: host, encoding: 'utf8', env: { PATH: process.env.PATH } });
assert.equal(ran.status, 0, ran.stderr);
const want = typesOf(ran.stdout);

console.log('node-util-types-match-node-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
let got;
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    await session.run(`mkdir -p ${W}`, 30_000);
    await session.writeFile(`${W}/types.cjs`, PROGRAM);
    const r = await session.run(`cd ${W} && node types.cjs`, 120_000);
    got = typesOf(splitScenarioOutput(r.stdout).lines.join('\n'));
  } finally {
    await session.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
assert.deepEqual(Object.keys(got), Object.keys(want), "util.types has Node's functions");
for (const name of Object.keys(want)) assert.deepEqual(got[name], want[name], `util.types.${name}`);
console.log(`node-util-types-match-node-workerd: ${Object.keys(want).length} functions answer as Node's`);
