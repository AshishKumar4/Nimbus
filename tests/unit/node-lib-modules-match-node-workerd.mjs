// @serial
// assert, assert/strict, querystring and punycode are Node v22.22.3's own
// modules (node-lib-source.ts, run over node-lib-host.ts): each program here
// prints what host Node prints, byte for byte, and exits as it does.
//
// Before, assert was a sketch: deepEqual compared JSON.stringify (a Map
// equalled an empty one, -0 equalled 0), deepStrictEqual was deepEqual,
// throws() ignored what it was asked to match, messages were one line, and
// AssertionError, match, rejects, strict and CallTracker were missing.
// querystring.parse kept one value of a repeated key and returned a plain
// object, stringify dropped arrays and null, and punycode was missing.
// util.deprecate warned nothing and util.isDeepStrictEqual was JSON.stringify.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { localTerminal, splitScenarioOutput, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/node-lib';
// What every program prints of an error: its kind, code, message, the
// AssertionError's fields, its own keys and its stack's header.
const SHOW = String.raw`
const show = (label, e) => {
  if (e === undefined) return console.log(label + ': no error');
  console.log(label + ': ' + e.name + ' ' + e.code + ' ' + JSON.stringify(e.message));
  console.log('  keys ' + JSON.stringify(Object.keys(e)) + ' generated ' + e.generatedMessage + ' operator ' + e.operator);
  console.log('  header ' + JSON.stringify(String(e.stack).split('\n')[0]));
};
const attempt = (label, fn) => { try { fn(); show(label); } catch (e) { show(label, e); } };
process.on('warning', (w) => console.log('warning: ' + w.name + ' ' + w.code + ' ' + w.message));
`;
const FILES = {
  'assert.cjs': SHOW + String.raw`
const assert = require('assert');
const util = require('util');
const x = 0;
attempt('ok source', () => assert.ok(x === 1));
attempt('assert source', () => assert(x));
attempt('ok none', () => assert.ok());
attempt('ok message', () => assert.ok(false, 'custom'));
attempt('ok error', () => assert.ok(false, new RangeError('thrown')));
attempt('strictEqual', () => assert.strictEqual(1, 2));
attempt('strictEqual strings', () => assert.strictEqual('hello world\nline two', 'hello world\nline 2'));
attempt('equal', () => assert.equal(1, '2'));
attempt('equal loose', () => assert.equal(1, '1'));
attempt('notStrictEqual', () => assert.notStrictEqual(1, 1));
attempt('deepStrictEqual', () => assert.deepStrictEqual({ a: 1, b: [1, 2], c: { d: 'x' } }, { a: 1, b: [1, 3], c: { d: 'y' } }));
attempt('deepStrictEqual map', () => assert.deepStrictEqual(new Map([[1, 2]]), new Map()));
attempt('deepStrictEqual set', () => assert.deepStrictEqual(new Set([1, 2]), new Set([2, 1])));
attempt('deepStrictEqual -0', () => assert.deepStrictEqual(-0, 0));
attempt('deepStrictEqual NaN', () => assert.deepStrictEqual(NaN, NaN));
attempt('deepStrictEqual proto', () => assert.deepStrictEqual(Object.create(null), {}));
attempt('deepStrictEqual date', () => assert.deepStrictEqual(new Date(0), new Date(1)));
attempt('deepStrictEqual long', () => assert.deepStrictEqual(Array.from({ length: 40 }, (_, i) => i), Array.from({ length: 40 }, (_, i) => (i === 20 ? -1 : i))));
attempt('deepEqual loose', () => assert.deepEqual({ a: 1 }, { a: '1' }));
attempt('deepEqual differs', () => assert.deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }));
attempt('notDeepStrictEqual', () => assert.notDeepStrictEqual({ a: 1 }, { a: 1 }));
attempt('throws none', () => assert.throws(() => {}));
attempt('throws regexp', () => assert.throws(() => { throw new Error('boom'); }, /bang/));
attempt('throws class', () => assert.throws(() => { throw new TypeError('t'); }, RangeError));
attempt('throws object', () => assert.throws(() => { throw new Error('boom'); }, { message: 'bang', name: 'Error' }));
attempt('throws passes', () => assert.throws(() => { throw new TypeError('t'); }, TypeError));
attempt('throws validate', () => assert.throws(() => { throw new Error('v'); }, () => false));
attempt('throws ambiguous', () => assert.throws(() => { throw new Error('same'); }, 'same'));
attempt('throws not fn', () => assert.throws('nope'));
attempt('doesNotThrow', () => assert.doesNotThrow(() => { throw new Error('boom'); }));
attempt('doesNotThrow message', () => assert.doesNotThrow(() => { throw new Error('boom'); }, 'because'));
attempt('match', () => assert.match('abc', /x/));
attempt('match type', () => assert.match(5, /x/));
attempt('doesNotMatch', () => assert.doesNotMatch('abc', /b/));
attempt('ifError', () => assert.ifError(new Error('upstream')));
attempt('ifError null', () => assert.ifError(null));
attempt('fail', () => assert.fail());
attempt('fail message', () => assert.fail('stop'));
attempt('strict equal', () => assert.strict.equal(1, '1'));
attempt('strict deepEqual', () => assert.strict.deepEqual([1], ['1']));
console.log('assert/strict is strict: ' + (require('assert/strict') === assert.strict) + ' ' + (require('node:assert/strict') === assert.strict));
const made = new assert.AssertionError({ actual: 1, expected: 2, operator: 'strictEqual' });
show('constructed', made);
console.log('instance ' + (made instanceof Error) + ' ' + (made instanceof assert.AssertionError));
console.log('isDeepStrictEqual ' + util.isDeepStrictEqual(new Map([[1, 2]]), new Map()) + ' ' + util.isDeepStrictEqual([1, { a: 2 }], [1, { a: 2 }]));
console.log('names ' + Object.keys(assert).join(','));
(async () => {
  try { await assert.rejects(Promise.resolve(1)); } catch (e) { show('rejects resolved', e); }
  try { await assert.rejects(Promise.reject(new Error('r')), /nope/); } catch (e) { show('rejects mismatch', e); }
  try { await assert.doesNotReject(Promise.reject(new Error('r'))); } catch (e) { show('doesNotReject', e); }
  try { await assert.rejects(() => 5); } catch (e) { show('rejects not promise', e); }
  const tracker = new assert.CallTracker();
  const called = tracker.calls(() => {}, 2);
  called();
  try { tracker.verify(); } catch (e) { show('verify', e); }
  console.log('report ' + JSON.stringify(tracker.report().map(({ message, actual, expected }) => ({ message, actual, expected }))));
})();
`,
  'querystring.cjs': SHOW + String.raw`
const qs = require('querystring');
console.log(qs.parse('a=1&a=2&b=%20x+y&c&=e&d=%E0%A4%A&f=1=2'));
console.log(qs.parse('a:1;b:2', ';', ':'));
console.log(qs.parse('a=1&b=2&c=3', null, null, { maxKeys: 2 }));
console.log(qs.parse('a=%41', null, null, { decodeURIComponent: (s) => s.toLowerCase() }));
console.log(qs.stringify({ a: [1, 2], b: 'x y', c: true, d: null, e: undefined, f: 1n, g: { h: 1 }, 'k é': 'ü' }));
console.log(qs.stringify({ a: 1, b: 2 }, ';', ':'));
console.log(qs.stringify('nope'), qs.stringify({ a: 'b' }, null, null, { encodeURIComponent: (s) => s.toUpperCase() }));
console.log(qs.escape('a b&c/é'), qs.unescape('a%20b%zz'), qs.unescapeBuffer('a%20b'));
console.log(qs.encode === qs.stringify, qs.decode === qs.parse, Object.keys(qs).join(','));
attempt('stringify lone surrogate', () => qs.stringify({ a: '\uD800' }));
`,
  'punycode.cjs': SHOW + String.raw`
const punycode = require('punycode');
console.log(punycode.encode('mañana'), punycode.decode('maana-pta'), punycode.toASCII('mañana.com'), punycode.toUnicode('xn--maana-pta.com'));
console.log(punycode.ucs2.decode('\uD834\uDF06'), punycode.ucs2.encode([0x1D306]), punycode.version, Object.keys(punycode).join(','));
attempt('decode invalid', () => punycode.decode('\x81'));
`,
  'punycode-package.cjs': SHOW + String.raw`
console.log(require('pkg').encoded, require('punycode').encode('ü'));
`,
  'node_modules/pkg/package.json': '{"name":"pkg","main":"index.js"}',
  'node_modules/pkg/index.js': "exports.encoded = require('punycode').encode('mañana');\n",
  'deprecate.cjs': SHOW + String.raw`
const util = require('util');
const old = util.deprecate(function old(a, b) { return a + b; }, 'old() is going away', 'DEP_NIMBUS');
console.log(old(1, 2), old.length, old.name);
const again = util.deprecate(() => 3, 'same code', 'DEP_NIMBUS');
console.log(again());
const plain = util.deprecate(() => 4, 'no code');
console.log(plain(), plain());
attempt('deprecate code', () => util.deprecate(() => {}, 'm', 5));
`,
};
const PROGRAMS = ['assert.cjs', 'querystring.cjs', 'punycode.cjs', 'punycode-package.cjs', 'deprecate.cjs'];

const host = mkdtempSync(join(tmpdir(), 'node-lib-'));
process.on('exit', () => rmSync(host, { recursive: true, force: true }));
for (const [path, text] of Object.entries(FILES)) {
  mkdirSync(dirname(join(host, path)), { recursive: true });
  writeFileSync(join(host, path), text);
}
const expected = new Map(PROGRAMS.map((program) => {
  const ran = spawnSync('node', [program], { cwd: host, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: host } });
  return [program, `${ran.stdout}exit ${ran.status}\n`];
}));

console.log('node-lib-modules-match-node-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
const differences = [];
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    const dirs = [...new Set(Object.keys(FILES).map((path) => dirname(`${W}/${path}`)))];
    const made = await session.run(`mkdir -p ${dirs.join(' ')}`, 30_000);
    assert.equal(made.status, 0, made.stdout);
    for (const [path, text] of Object.entries(FILES)) await session.writeFile(`${W}/${path}`, text);
    for (const program of PROGRAMS) {
      const r = await session.run(`cd ${W} && node ${program} > out.txt 2>/dev/null; echo "exit $?" >> out.txt; cat out.txt`, 120_000);
      const got = `${splitScenarioOutput(r.stdout).lines.join('\n')}\n`;
      if (got !== expected.get(program)) differences.push({ program, node: expected.get(program), here: got });
    }
  } finally {
    await session.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
for (const { program, node, here } of differences) {
  const a = node.split('\n');
  const b = here.split('\n');
  const at = a.findIndex((line, i) => line !== b[i]);
  console.log(`${program}: first difference at line ${at + 1}\n  node: ${JSON.stringify(a.slice(at, at + 4))}\n  here: ${JSON.stringify(b.slice(at, at + 4))}`);
}
assert.deepEqual(differences.map((d) => d.program), [], 'each program prints what Node prints');
console.log(`node-lib-modules-match-node-workerd: ${PROGRAMS.length} programs print what Node prints`);
