// @serial
// assert, assert/strict, util, querystring and punycode are Node v22.22.3's own
// modules (node-lib-source.ts, run over node-lib-host.ts): each program here
// prints what host Node prints, byte for byte, and exits as it does.
//
// Before, assert was a sketch: deepEqual compared JSON.stringify (a Map
// equalled an empty one, -0 equalled 0), deepStrictEqual was deepEqual,
// throws() ignored what it was asked to match, messages were one line, and
// AssertionError, match, rejects, strict and CallTracker were missing.
// querystring.parse kept one value of a repeated key and returned a plain
// object, stringify dropped arrays and null, and punycode was missing.
// util was a sketch too: deprecate warned nothing, isDeepStrictEqual was
// JSON.stringify, promisify knew no util.promisify.custom (promisify(exec)
// resolved stdout alone, promisify(setTimeout) never resolved), styleText
// colored a pipe and took any style, inherits took no superclass, parseArgs
// was a port of its own, and MIMEType, parseEnv, getSystemErrorName, aborted,
// getCallSites, diff, debug, the deprecated is* checks and _extend were
// missing.
//
// Which builtins there are is one decision (node-shims.ts __nimbusBuiltinId)
// for require, import, module.isBuiltin, module.builtinModules and
// process.getBuiltinModule. Before, each decided for itself: bare 'sqlite'
// was a builtin (shadowing npm's sqlite), getBuiltinModule('undici') answered
// the provided package, builtinModules listed node:-prefixed duplicates, and
// sys, path/posix, path/win32, _stream_* and timers.promises were missing.
// string_decoder was TextDecoder's: hex, base64 and latin1 threw.
//
// A module is Node's Module (filename, id, paths, loaded, children, parent),
// require.cache is Module._cache of them by file, every require is one
// makeRequireFunction's (resolve with its paths option, resolve.paths,
// extensions, main), and what it cannot find is MODULE_NOT_FOUND with the
// require stack. Before, a module was { exports } and the entry had no
// filename, require.cache was an internal Map, a module's require.resolve
// answered a path without its leading slash and threw for a builtin, and
// a missing module threw an Error without a code, so a program's
// \`e.code === 'MODULE_NOT_FOUND'\` check for an optional dependency failed.
// require.cache holds what Node's holds: CommonJS modules however they
// loaded, an ES module once required, an entry whose load threw no longer.
// util.getCallSites, assert's source expression and punycode's
// isInsideNodeModules read V8's sites as Node's bindings do, whatever the
// program set Error's hooks and limit to (node-shims.ts names the limit: a
// builtin replaced before the library's first use is what its primordials hold).
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
  'util.cjs': SHOW + String.raw`
const util = require('util');
const { exec, execFile } = require('child_process');
const show2 = (label, f) => { try { const r = f(); console.log(label + ': ' + (typeof r === 'string' ? r : JSON.stringify(r))); } catch (e) { show(label, e); } };
// In JSON, its escapes are text the terminal keeps.
show2('styleText pipe', () => [util.styleText('red', 'plain')]);
show2('styleText unchecked', () => [util.styleText(['bold', 'underline'], 'styled', { validateStream: false }), util.styleText('dim', util.styleText('bold', 'nest') + 'ed', { validateStream: false })]);
show2('styleText unknown', () => util.styleText('nope', 'x'));
show2('styleText text', () => util.styleText('red', 5));
show2('parseArgs', () => util.parseArgs({ args: ['-f', '--bar', 'b', '--', 'x'], options: { foo: { type: 'boolean', short: 'f' }, bar: { type: 'string' } }, allowPositionals: true }));
show2('parseArgs tokens', () => util.parseArgs({ args: ['-ab', '--c=1'], options: { a: { type: 'boolean', short: 'a' }, b: { type: 'boolean', short: 'b' }, c: { type: 'string' } }, tokens: true }).tokens);
show2('parseArgs unknown', () => util.parseArgs({ args: ['--x'], options: {} }));
show2('parseArgs positional', () => util.parseArgs({ args: ['pos'], options: {} }));
show2('parseArgs missing', () => util.parseArgs({ args: ['--s'], options: { s: { type: 'string' } } }));
// json-server's bin reads its options with parseArgs at module init.
const jsonServer = { port: { type: 'string', short: 'p', default: '3000' }, host: { type: 'string', short: 'h', default: 'localhost' }, static: { type: 'string', short: 's', multiple: true, default: [] }, help: { type: 'boolean' }, version: { type: 'boolean' } };
show2('parseArgs defaults', () => util.parseArgs({ args: ['--version'], options: jsonServer, allowPositionals: true }));
show2('parseArgs multiple', () => util.parseArgs({ args: ['-p', '4000', '--host=0.0.0.0', '-s', 'public', '-s', 'assets', 'db.json'], options: jsonServer, allowPositionals: true }));
const opts = { verbose: { type: 'boolean', short: 'v' }, force: { type: 'boolean', short: 'f' }, out: { type: 'string', short: 'o' }, color: { type: 'boolean' } };
show2('parseArgs grouped', () => util.parseArgs({ args: ['-vf', '-odist', '--', '--not-an-option', 'x'], options: opts, allowPositionals: true }));
show2('parseArgs negative', () => util.parseArgs({ args: ['--no-color'], options: opts, allowNegative: true }));
show2('parseArgs option value', () => util.parseArgs({ args: ['--out', '--verbose'], options: opts }));
show2('parseArgs boolean value', () => util.parseArgs({ args: ['--verbose=yes'], options: opts }));
show2('parseArgs bad type', () => util.parseArgs({ args: [], options: { bad: { type: 'number' } } }));
show2('parseArgs lax', () => util.parseArgs({ args: ['--unknown', 'pos', '--k=v'], strict: false }));
show2('parseArgs argv', () => util.parseArgs({ strict: false }));
show2('parseEnv', () => util.parseEnv('A=1\nexport B="x\\ny"\n# c\nC=\'q\' # tail\nD=\x60b\x60\nE\nF=  sp  \nG="multi\nline"\nZ=9\n10=t\nH="open\nI=last'));
show2('system errors', () => [util.getSystemErrorName(-2), util.getSystemErrorMessage(-13), util.getSystemErrorName(-99999), util.getSystemErrorMap().size, util.getSystemErrorMap().get(-98)]);
show2('system error positive', () => util.getSystemErrorName(1));
show2('system error type', () => util.getSystemErrorMessage('x'));
show2('errnoException', () => { const e = util._errnoException(-2, 'open', 'x'); return [e.message, Object.keys(e), e.constructor.name]; });
show2('exceptionWithHostPort', () => { const e = util._exceptionWithHostPort(-111, 'connect', '1.2.3.4', 80, 'here'); return [e.message, Object.keys(e)]; });
show2('MIMEType', () => { const m = new util.MIMEType('Text/HTML; Charset="utf-8"; q=1'); m.params.set('x', 'y z'); return [String(m), m.essence, [...m.params.keys()]]; });
show2('MIMEType bad', () => new util.MIMEType('bad'));
show2('toUSVString', () => util.toUSVString('a\ud800b'));
show2('inherits none', () => util.inherits(function A() {}, undefined));
show2('inherits', () => { function A() {} function B() {} util.inherits(A, B); return [Object.getPrototypeOf(A.prototype) === B.prototype, A.super_ === B]; });
show2('promisify none', () => util.promisify(5));
show2('callbackify none', () => util.callbackify(5));
show2('legacy checks', () => [util.isArray([]), util.isBoolean(1), util.isBuffer(Buffer.alloc(1)), util.isDate(new Date()), util.isError(new Error()), util.isFunction(() => {}), util.isNull(null), util.isNullOrUndefined(undefined), util.isNumber(1), util.isObject({}), util.isPrimitive('s'), util.isRegExp(/x/), util.isString('s'), util.isSymbol(Symbol()), util.isUndefined(undefined)]);
show2('extend', () => util._extend({ a: 1 }, { b: 2 }));
show2('diff', () => util.diff(['a', 'b', 'c'], ['a', 'x', 'c']));
show2('diff strings', () => util.diff('abc', 'abd'));
show2('debuglog', () => [typeof util.debuglog('nimbus'), util.debuglog('nimbus').enabled, util.debug === util.debuglog]);
show2('callsites', () => util.getCallSites(1).map(({ functionName, scriptName, lineNumber, columnNumber, column }) => [functionName, scriptName.split('/').at(-1), lineNumber, columnNumber, column]));
show2('callsites range', () => util.getCallSites(0));
show2('deepStrictEqual', () => [util.isDeepStrictEqual(new Set([1]), new Set([1])), util.isDeepStrictEqual([1], ['1'])]);
show2('names', () => Object.keys(util).join(','));
show2('promisify.custom', () => [typeof setTimeout[util.promisify.custom], typeof exec[util.promisify.custom], util.promisify(exec) === exec[util.promisify.custom]]);
(async () => {
  console.log('promisify', await util.promisify((x, cb) => cb(null, x * 2))(21));
  try { await util.promisify((cb) => cb(new RangeError('cb')))(); } catch (e) { console.log('promisify rejects', e.message); }
  console.log('promisify setTimeout', await util.promisify(setTimeout)(1, 'later'));
  console.log('promisify exec', JSON.stringify(await util.promisify(exec)('echo hi')));
  try { await util.promisify(execFile)('sh', ['-c', 'echo out; echo err >&2; exit 3']); } catch (e) { console.log('promisify execFile fails', e.code, JSON.stringify(e.stdout), JSON.stringify(e.stderr)); }
  await new Promise((resolve) => util.callbackify(async () => { throw null; })((e) => { console.log('callbackify', Object.keys(e), e.message, e.reason); resolve(); }));
  await new Promise((resolve) => util.callbackify(async (x) => x + 1)(1, (e, v) => { console.log('callbackify value', e, v); resolve(); }));
  await util.aborted(AbortSignal.abort(), {});
  console.log('aborted');
  try { await util.aborted({}, {}); } catch (e) { show('aborted not a signal', e); }
  // Its listener is the one an earlier listener's stopImmediatePropagation does not stop.
  const controller = new AbortController();
  controller.signal.addEventListener('abort', (event) => { event.stopImmediatePropagation(); console.log('first abort listener'); });
  const aborted = util.aborted(controller.signal, {}).then(() => 'resolved');
  controller.abort();
  console.log('aborted past a stopped dispatch ' + await Promise.race([aborted, new Promise((resolve) => setTimeout(() => resolve('pending'), 50))]));
})();
`,
  'identity.cjs': SHOW + String.raw`
const Module = require('module');
const show2 = (label, f) => { try { const r = f(); console.log(label + ': ' + (typeof r === 'string' ? r : JSON.stringify(r))); } catch (e) { show(label, e); } };
for (const id of ['fs', 'node:fs', 'sqlite', 'node:sqlite', 'test', 'undici', 'node:undici', 'node:nope', 'sys', 'path/posix', 'path/win32', 'node:util/types', 'node:fs/promises', '_stream_readable', 'string_decoder']) {
  show2('isBuiltin ' + id, () => Module.isBuiltin(id));
  // node:sqlite loaded warns of its own (sqlite-shim.ts, not here).
  if (id !== 'node:sqlite') show2('getBuiltinModule ' + id, () => typeof process.getBuiltinModule(id));
}
show2('isBuiltin 5', () => Module.isBuiltin(5));
show2('getBuiltinModule 5', () => process.getBuiltinModule(5));
show2('require node:nope', () => require('node:nope'));
show2('require node:undici', () => require('node:undici'));
show2('require sqlite', () => { try { require('sqlite'); return 'loaded'; } catch { return 'not found'; } });
show2('node: prefixed listed', () => Module.builtinModules.filter((id) => id.startsWith('node:') || id === 'sqlite' || id === 'undici'));
show2('aliases', () => [require('sys') === require('util'), require('sys') === require('node:sys'), require('path/posix') === require('path').posix, require('path/win32') === require('path').win32,
  require('_stream_readable') === require('stream').Readable, require('_stream_writable') === require('stream').Writable, require('_stream_duplex') === require('stream').Duplex,
  require('_stream_transform') === require('stream').Transform, require('_stream_passthrough') === require('stream').PassThrough, require('timers').promises === require('timers/promises'),
  require('node:util/types') === require('util').types, require('node:fs/promises') === require('fs').promises]);
show2('win32 join', () => require('path/win32').join('a', 'b'));
const { StringDecoder } = require('string_decoder');
show2('string_decoder', () => {
  const utf8 = new StringDecoder('utf8');
  const hex = new StringDecoder('hex');
  const b64 = new StringDecoder('base64');
  const u16 = new StringDecoder('utf16le');
  return [utf8.write(Buffer.from([0xe2, 0x82])), utf8.write(Buffer.from([0xac])), utf8.end(Buffer.from([0xe2])), hex.write(Buffer.from([1, 255])), b64.write(Buffer.from('ab')), b64.end(),
    u16.write(Buffer.from([0x61])), u16.write(Buffer.from([0x00, 0x62])), new StringDecoder('latin1').write(Buffer.from([0xe9])), new StringDecoder().encoding, new StringDecoder('UCS2').encoding];
});
show2('string_decoder unknown', () => new StringDecoder('nope'));
`,
  'mods/main.cjs': SHOW + String.raw`
const Module = require('module');
const path = require('path');
// Paths as the test's directory names them, the same on both sides.
const rel = (p) => (typeof p === 'string' && p.startsWith('/') ? path.relative(__dirname, p) || '.' : p);
const shape = (m) => m && { ctor: m.constructor.name, module: m instanceof Module, id: rel(m.id), path: rel(m.path), filename: rel(m.filename), loaded: m.loaded,
  children: m.children.map((c) => rel(c.filename)), paths: m.paths?.slice(0, 2).map(rel), keys: Object.keys(m), parent: m.parent === undefined ? 'undefined' : m.parent === null ? 'null' : rel(m.parent.filename) };
const notFound = (label, f) => {
  try { f(); console.log(label + ': found'); } catch (e) {
    console.log(label + ': ' + e.name + ' ' + e.code + ' ' + JSON.stringify(e.message.split(__dirname).join('<dir>')) + ' ' + JSON.stringify(Object.keys(e)) + ' ' + JSON.stringify(e.requireStack?.map(rel)));
  }
};
console.log('entry ' + JSON.stringify(shape(module)));
console.log('main ' + [require.main === module, process.mainModule === module, module.id, __filename === module.filename].join(' '));
const child = require('./child.cjs');
console.log('child ' + JSON.stringify(child));
console.log('after ' + JSON.stringify(shape(module)));
console.log('cache ' + JSON.stringify(Object.keys(require.cache).map(rel)));
console.log('cache entries ' + [require.cache[require.resolve('./child.cjs')] instanceof Module, require.cache[__filename] === module, require.cache === Module._cache, require.extensions === Module._extensions].join(' '));
console.log('again ' + (require('./child.cjs') === child) + ' ' + module.children.length);
delete require.cache[require.resolve('./child.cjs')];
console.log('fresh ' + require('./child.cjs').count);
require.cache[path.join(__dirname, 'fake.cjs')] = { exports: 'from the cache' };
console.log('injected ' + require('./fake.cjs') + ' ' + module.children.length);
console.log('resolve ' + [rel(require.resolve('./child.cjs')), require.resolve('fs'), require.resolve('node:fs'), rel(require.resolve('dep')), rel(require.resolve('./nested.cjs', { paths: [path.join(__dirname, 'sub')] })), rel(require.resolve('dep', { paths: [path.join(__dirname, 'sub'), '/'] }))].join(' '));
console.log('resolve paths ' + JSON.stringify([require.resolve.paths('dep').slice(0, 2).map(rel), require.resolve.paths('fs'), require.resolve.paths('./x').map(rel), require.resolve.paths('../x').map(rel)]));
console.log('dep ' + JSON.stringify(require('dep')));
console.log('json ' + JSON.stringify(require('./data.json')) + ' ' + (require.cache[path.join(__dirname, 'data.json')].loaded));
notFound('json broken', () => require('./broken.json'));
notFound('require missing', () => require('nope-pkg'));
notFound('require missing relative', () => require('./nope'));
notFound('resolve missing', () => require.resolve('nope-pkg'));
notFound('resolve node:nope', () => require.resolve('node:nope'));
notFound('nested missing', () => require('./sub/nested.cjs'));
console.log('nested unloaded ' + (require.cache[path.join(__dirname, 'sub/nested.cjs')] === undefined) + ' ' + module.children.map((c) => rel(c.filename)).join(','));
notFound('require empty', () => require(''));
notFound('require number', () => require(5));
notFound('resolve number', () => require.resolve(5));
notFound('resolve bad paths', () => require.resolve('dep', { paths: 'x' }));
// options.paths' relative entries are the working directory's (the host's root here).
console.log('resolve relative paths ' + [rel(require.resolve('./child.cjs', { paths: ['mods'] })), rel(require.resolve('dep', { paths: ['mods/sub'] })), rel(require.resolve('./nested.cjs', { paths: ['nope', 'mods/sub'] }))].join(' '));
notFound('resolve paths number', () => require.resolve('dep', { paths: [5] }));
notFound('resolve paths null after a hit', () => require.resolve('./child.cjs', { paths: ['mods', null] }));
notFound('resolve bare paths null after a hit', () => require.resolve('dep', { paths: ['mods', null] }));
const fromDir = Module.createRequire(path.join(__dirname, 'sub') + '/');
notFound('createRequire dir', () => fromDir('zz'));
console.log('createRequire ' + [rel(Module.createRequire(__filename).resolve('./child.cjs')), Module.createRequire(__filename).main === module, rel(Module.createRequire(require('url').pathToFileURL(__filename)).resolve('dep'))].join(' '));
notFound('createRequire relative', () => Module.createRequire('rel.js'));
notFound('createRequire number', () => Module.createRequire(5));
const made = new Module(path.join(__dirname, 'made.js'), module);
console.log('made ' + JSON.stringify(shape(made)));
notFound('_resolveFilename', () => Module._resolveFilename('nope-pkg', null));
console.log('loaded at the end ' + module.loaded);
setTimeout(() => console.log('loaded after ' + module.loaded), 0);
`,
  'mods/child.cjs': `const path = require('path');
const rel = (p) => path.relative(__dirname, p);
globalThis.count = (globalThis.count ?? 0) + 1;
module.exports = { count: globalThis.count, parent: rel(module.parent.filename), main: require.main === module, mainFile: rel(require.main.filename), id: rel(module.id), loaded: module.loaded, keys: Object.keys(module), resolved: rel(require.resolve('./sub/nested.cjs')) };
`,
  'mods/fake.cjs': "module.exports = 'from the file';\n",
  'mods/sub/nested.cjs': "require('nope-nested');\n",
  'mods/data.json': '\uFEFF{ "a": [1, 2] }',
  'mods/broken.json': '{ "a": ',
  'mods/node_modules/dep/package.json': '{"name":"dep","main":"lib/index.js"}',
  'mods/node_modules/dep/lib/index.js': "const path = require('path');\nmodule.exports = { parent: path.basename(module.parent.filename), self: path.relative(__dirname, require.resolve('./index.js')), paths: module.paths.slice(0, 2).map((p) => path.relative(__dirname, p)) };\n",
  'mods/pre.cjs': "try { require('nope-pre'); } catch (e) { console.log('preload ' + e.code + ' ' + JSON.stringify(e.requireStack.map((p) => require('path').basename(p))) + ' ' + (require.main === undefined) + ' ' + (process.mainModule === undefined) + ' ' + module.parent.id); }\n",
  'mods/plain.cjs': "console.log('plain main ' + (require.main === module) + ' ' + module.id);\n",
  'mods/stdin.cjs': "const path = require('path');\nconsole.log('stdin ' + [__filename, __dirname, module.id, path.basename(module.filename), require.main === undefined, process.mainModule === undefined, module.paths.length > 0].join(' '));\ntry { require('nope-stdin'); } catch (e) { console.log('stdin missing ' + JSON.stringify(e.requireStack.map((p) => path.basename(p)))); }\n",
  'mods/throws.cjs': "process.on('uncaughtException', (e) => console.log('caught ' + e.message + ' ' + (require.cache[__filename] === undefined) + ' ' + Object.keys(require.cache).length + ' ' + (require.main === module)));\nthrow new Error('entry threw');\n",
  'mods/esm/cache.cjs': String.raw`const path = require('path');
const keys = () => JSON.stringify(Object.keys(require.cache).map((k) => path.relative(__dirname, k)));
(async () => {
  await import('./e.mjs');
  await import('./c.cjs');
  await import('./s.mjs');
  await import('./e.mjs?v=1');
  await import('./d.json', { with: { type: 'json' } });
  console.log('imported ' + keys());
  require('./r.mjs');
  console.log('required esm ' + keys());
  console.log('required imported esm ' + (require('./e.mjs').e) + ' ' + keys());
  delete require.cache[require.resolve('./r.mjs')];
  console.log('required again ' + (require('./r.mjs').r) + ' ' + globalThis.rCount + ' ' + keys());
})();
`,
  // What util.aborted keeps for waiters on one signal: here one follower
  // signal (AbortSignal.any) however many wait, as Node keeps one listener each.
  'aborted-bound.cjs': String.raw`
const util = require('util');
const any = AbortSignal.any;
let followers = 0;
AbortSignal.any = function (...args) { followers++; return Reflect.apply(any, this, args); };
const controller = new AbortController();
const waits = Array.from({ length: 1000 }, () => util.aborted(controller.signal, {}));
controller.abort();
Promise.all(waits).then(() => console.log('BOUND ' + JSON.stringify({ followers, settled: waits.length })));
`,
  // Both made non-configurable and non-writable: no JavaScript path reads the
  // stack (commonjs-cell.ts __nimbusStackSites names the limit), and the
  // answer is none, not made-up frames.
  'locked.cjs': String.raw`
const util = require('util');
Object.defineProperty(Error, 'prepareStackTrace', { value: () => 'locked', writable: false, enumerable: false, configurable: false });
Object.defineProperty(Error, 'stackTraceLimit', { value: 0, writable: false, enumerable: true, configurable: false });
console.log('LOCKED ' + JSON.stringify(util.getCallSites(3)));
`,
  'mods/esm/e.mjs': 'export const e = 1;\n',
  'mods/esm/r.mjs': 'globalThis.rCount = (globalThis.rCount ?? 0) + 1;\nexport const r = 2;\n',
  'mods/esm/c.cjs': 'exports.c = 1;\n',
  'mods/esm/c2.cjs': 'exports.c2 = 1;\n',
  'mods/esm/e2.mjs': 'export const e2 = 1;\n',
  'mods/esm/s.mjs': "import './c2.cjs';\nimport './e2.mjs';\nexport const s = 1;\n",
  'mods/esm/d.json': '{ "d": 1 }',
  'sites.cjs': SHOW + String.raw`
const util = require('util');
const assert = require('assert');
const path = require('path');
const sites = () => util.getCallSites(1).map((s) => [s.functionName, path.basename(s.scriptName), s.lineNumber]);
const x = 0;
let formatted = 0;
const message = () => { try { assert.ok(x === 1); } catch (e) { return JSON.stringify(e.message); } };
// Error's own hook and limit, as the program left them.
const descriptors = () => JSON.stringify([typeof Error.prepareStackTrace, Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit')]);
console.log('plain ' + JSON.stringify(sites()) + ' ' + message() + ' ' + descriptors());
Error.prepareStackTrace = (e, s) => { formatted++; return 'custom'; };
console.log('assigned hook ' + JSON.stringify(sites()) + ' ' + message() + ' ' + formatted + ' ' + descriptors());
const hook = (e, s) => { formatted++; return 'defined'; };
Object.defineProperty(Error, 'prepareStackTrace', { value: hook, configurable: true, writable: true });
console.log('defined hook ' + JSON.stringify(sites()) + ' ' + message() + ' ' + formatted + ' ' + descriptors() + ' ' + (Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace').value === hook));
delete Error.prepareStackTrace;
Error.stackTraceLimit = 0;
console.log('limit 0 ' + JSON.stringify(sites()) + ' ' + message() + ' ' + descriptors());
Error.stackTraceLimit = 10;
const capture = Error.captureStackTrace;
Error.captureStackTrace = () => {};
console.log('capture replaced ' + JSON.stringify(sites()) + ' ' + message());
Error.captureStackTrace = capture;
Object.defineProperty(Error, 'stackTraceLimit', { value: 3, writable: false, enumerable: true, configurable: true });
console.log('limit locked ' + JSON.stringify(sites()) + ' ' + descriptors());
// Pinned for good but still writable.
Object.defineProperty(Error, 'stackTraceLimit', { value: 0, writable: true, enumerable: true, configurable: false });
Object.defineProperty(Error, 'prepareStackTrace', { value: (e, s) => { formatted++; return 'pinned'; }, writable: true, enumerable: false, configurable: false });
console.log('pinned writable ' + JSON.stringify(sites()) + ' ' + message() + ' ' + formatted + ' ' + descriptors() + ' ' + new Error('e').stack);
`,
  'os.cjs': SHOW + String.raw`
const os = require('os');
const { execFile } = require('child_process');
const show2 = (label, f) => { try { const r = f(); console.log(label + ': ' + JSON.stringify(r)); } catch (e) { show(label, e); } };
// The system's identity is uname's (on each side its own system's).
const uname = (flag) => new Promise((resolve, reject) => execFile('uname', [flag], { encoding: 'utf8' }, (e, out) => (e ? reject(e) : resolve(out.trim()))));
(async () => {
const [s, r, v, m, n] = await Promise.all(['-s', '-r', '-v', '-m', '-n'].map(uname));
show2('identity is uname', () => [os.type() === s, os.release() === r, os.version() === v, os.machine() === m, os.hostname() === n]);
show2('devNull', () => os.devNull);
show2('getPriority', () => [os.getPriority(), os.getPriority(process.pid)]);
show2('getPriority type', () => os.getPriority('x'));
show2('getPriority float', () => os.getPriority(1.5));
show2('setPriority range', () => os.setPriority(30));
show2('setPriority float', () => os.setPriority(0, 1.5));
show2('setPriority none', () => os.setPriority());
show2('setPriority raise', () => [os.setPriority(10), os.getPriority()]);
show2('setPriority lower', () => os.setPriority(5));
show2('setPriority lower info', () => { try { os.setPriority(0, 0); } catch (e) { return [e.info, e.errno, e.syscall]; } });
show2('still', () => os.getPriority());
})();
`,
  'perf.cjs': SHOW + String.raw`
const ph = require('perf_hooks');
const show2 = (label, f) => { try { const r = f(); console.log(label + ': ' + JSON.stringify(r)); } catch (e) { show(label, e); } };
show2('identity', () => [ph.performance === globalThis.performance, ph.PerformanceEntry === globalThis.PerformanceEntry, ph.PerformanceObserver === globalThis.PerformanceObserver, ph.PerformanceMark === globalThis.PerformanceMark]);
show2('kinds', () => Object.keys(ph).map((k) => k + ':' + typeof ph[k]));
show2('mark', () => { const m = ph.performance.mark('m1', { detail: { a: 1 } }); return [m.name, m.entryType, m.detail, m instanceof ph.PerformanceMark]; });
show2('measure', () => { ph.performance.mark('m2'); const m = ph.performance.measure('span', 'm1', 'm2'); return [m.name, m.entryType, typeof m.duration]; });
show2('entries', () => ph.performance.getEntriesByType('mark').map((e) => e.name));
show2('constants', () => [ph.constants.NODE_PERFORMANCE_GC_MAJOR, ph.constants.NODE_PERFORMANCE_GC_MINOR]);
show2('timerify', () => ph.performance.timerify(function f() { return 1; })());
`,
  'streamweb.cjs': SHOW + String.raw`
const sw = require('stream/web');
console.log('names ' + Object.keys(sw).join(','));
console.log('globals ' + Object.keys(sw).every((k) => sw[k] === globalThis[k]));
(async () => {
  const r = new sw.ReadableStream({ start(c) { c.enqueue('a'); c.enqueue('b'); c.close(); } });
  const out = [];
  for await (const chunk of r.pipeThrough(new sw.TextEncoderStream()).pipeThrough(new sw.TextDecoderStream())) out.push(chunk);
  console.log('piped ' + JSON.stringify(out.join('')));
})();
`,
  'timers.cjs': SHOW + String.raw`
const timers = require('timers');
const tp = require('timers/promises');
const show2 = (label, f) => { try { const r = f(); console.log(label + ': ' + JSON.stringify(r)); } catch (e) { show(label, e); } };
show2('identity', () => ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval'].map((k) => timers[k] === globalThis[k]));
show2('promises', () => [timers.promises === tp, require('node:timers/promises') === tp, typeof tp.scheduler.wait, typeof tp.scheduler.yield]);
show2('names', () => Object.keys(timers));
show2('scheduler construct', () => new (Object.getPrototypeOf(tp.scheduler).constructor)());
show2('scheduler this', () => tp.scheduler.wait.call({}, 1));
let itemFired;
const fired = new Promise((resolve) => { itemFired = resolve; });
const item = { _onTimeout() { console.log('enrolled item fired ' + this._idleTimeout); itemFired(); } };
show2('enroll bad', () => timers.enroll(item, -1));
timers.enroll(item, 5);
timers.active(item);
const gone = { _onTimeout() { console.log('unenrolled item fired (should not)'); } };
timers.enroll(gone, 5);
timers.active(gone);
timers.unenroll(gone);
show2('unenrolled', () => [gone._idleTimeout, gone._destroyed]);
(async () => {
  await fired;
  console.log('setTimeout ' + await tp.setTimeout(1, 'v'));
  console.log('setImmediate ' + await tp.setImmediate('i'));
  console.log('wait ' + await tp.scheduler.wait(1));
  for (const [label, run] of [
    ['delay type', () => tp.setTimeout('x')],
    ['options type', () => tp.setTimeout(1, 1, 5)],
    ['signal type', () => tp.setTimeout(1, 1, { signal: {} })],
    ['ref type', () => tp.setImmediate(1, { ref: 1 })],
    ['aborted', () => tp.setTimeout(1, 1, { signal: AbortSignal.abort('why') })],
  ]) {
    try { await run(); console.log(label + ': resolved'); } catch (e) { show(label, e); console.log('  cause ' + JSON.stringify(e.cause)); }
  }
  const controller = new AbortController();
  controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
  const pending = tp.setTimeout(10000, 'late', { signal: controller.signal });
  controller.abort(new Error('stop'));
  try { await pending; } catch (e) { console.log('aborted past a stopped dispatch: ' + e.name + ' ' + e.cause.message); }
  const values = [];
  for await (const v of tp.setInterval(1, 'tick')) { values.push(v); if (values.length === 3) break; }
  console.log('interval ' + JSON.stringify(values));
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 5);
  try { for await (const v of tp.setInterval(1, 'x', { signal: stop.signal })); } catch (e) { console.log('interval aborted ' + e.name + ' ' + e.code); }
})();
`,
  // An unreferenced timer, interval or immediate lets the program end: Node
  // exits without running them.
  'unref.cjs': String.raw`
setTimeout(() => console.log('unref timeout fired (should not)'), 2000).unref();
setInterval(() => console.log('unref interval fired (should not)'), 500).unref();
const t = setTimeout(() => console.log('re-referenced timeout fired'), 20);
t.unref();
t.ref();
console.log('hasRef ' + t.hasRef() + ' ' + t.ref.name + ' ' + t.unref.name);
console.log('main done');
`,
  'process.cjs': SHOW + String.raw`
const EventEmitter = require('events');
const show2 = (label, f) => { try { const r = f(); console.log(label + ': ' + (typeof r === 'string' ? r : JSON.stringify(r))); } catch (e) { show(label, e); } };
show2('emitter', () => [process instanceof EventEmitter, process.constructor.name, Object.getPrototypeOf(Object.getPrototypeOf(process)) === EventEmitter.prototype,
  Object.hasOwn(process, 'on'), typeof process._events, typeof process._eventsCount, process.listenerCount('nimbus-x')]);
let heard;
process.on('nimbus-x', (v) => { heard = v; });
show2('emit', () => [process.emit('nimbus-x', 7), heard, process.listenerCount('nimbus-x'), process.eventNames().includes('nimbus-x')]);
show2('identity', () => [process.argv0, process.argv[0] === process.execPath, process.release.name, process.release.lts, process.debugPort, process.domain]);
show2('hrtime', () => { const a = process.hrtime(); const d = process.hrtime(a); return [a.length, typeof a[0], d[0] >= 0 && d[1] >= 0 && d[1] < 1e9, typeof process.hrtime.bigint()]; });
show2('hrtime array', () => process.hrtime(5));
show2('hrtime length', () => process.hrtime([1]));
show2('cpuUsage shape', () => Object.keys(process.cpuUsage()));
show2('cpuUsage prev', () => process.cpuUsage({ user: -1, system: 0 }));
show2('cpuUsage type', () => process.cpuUsage({ user: 'x', system: 0 }));
show2('cpuUsage object', () => process.cpuUsage(5));
show2('threadCpuUsage shape', () => Object.keys(process.threadCpuUsage()));
show2('resourceUsage shape', () => Object.keys(process.resourceUsage()));
show2('memoryUsage shape', () => [Object.keys(process.memoryUsage()), typeof process.memoryUsage.rss()]);
show2('kill float', () => process.kill(1.5));
show2('kill string pid', () => process.kill('abc'));
show2('kill signal', () => process.kill(process.pid, 'SIGNOPE'));
show2('kill probe', () => process.kill(process.pid, 0));
show2('kill probe by string', () => process.kill(String(process.pid), 0));
show2('assert', () => process.assert(false, 'm'));
show2('assert ok', () => process.assert(true));
show2('capture', () => { process.setUncaughtExceptionCaptureCallback(() => {}); const had = process.hasUncaughtExceptionCaptureCallback(); try { process.setUncaughtExceptionCaptureCallback(() => {}); } catch (e) { return [had, e.code, e.message]; } });
show2('capture bad', () => process.setUncaughtExceptionCaptureCallback(5));
show2('capture clear', () => [process.setUncaughtExceptionCaptureCallback(null), process.hasUncaughtExceptionCaptureCallback()]);
show2('ref', () => { const calls = []; process.ref({ [Symbol.for('nodejs.ref')]() { calls.push('sym'); }, ref() { calls.push('ref'); } }); process.unref({ unref() { calls.push('unref'); } }); process.ref(null); return calls; });
show2('flags', () => { const f = process.allowedNodeEnvironmentFlags; return [f.size > 50, f.has('--max-old-space-size'), f.has('max_old_space_size'), f.has('--max-old-space-size=4'), f.has('--no-warnings'), f.has('--expose-gc'), f.has('inspect'), Object.isFrozen(f), f instanceof Set]; });
show2('loadEnvFile missing', () => process.loadEnvFile('nope.env'));
show2('loadEnvFile type', () => process.loadEnvFile(5));
process.env.KEEP = 'mine';
show2('loadEnvFile', () => [process.loadEnvFile('envs/app.env'), process.env.FROM_FILE, process.env.QUOTED, process.env.KEEP]);
show2('uptime', () => typeof process.uptime() === 'number' && process.uptime() >= 0 && process.uptime() < 600);
show2('memory', () => [typeof process.availableMemory(), typeof process.constrainedMemory()]);
show2('rawDebug', () => typeof process._rawDebug);
`,
  'envs/app.env': 'FROM_FILE=yes\nQUOTED="a b"\nKEEP=file\n',
  'capture.cjs': String.raw`
process.on('uncaughtExceptionMonitor', (e, type) => console.log('monitor ' + e.message + ' ' + type));
process.on('uncaughtException', () => console.log('uncaughtException (should not)'));
process.setUncaughtExceptionCaptureCallback((e) => console.log('captured ' + e.message));
setTimeout(() => { throw new Error('later'); }, 1);
setTimeout(() => console.log('still running'), 20);
`,
  'fsstats.cjs': SHOW + String.raw`
const fs = require('fs');
const show2 = (label, f) => { try { const r = f(); console.log(label + ': ' + (typeof r === 'string' ? r : JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v)))); } catch (e) { show(label, e); } };
fs.writeFileSync('statted.txt', 'x'.repeat(5000));
fs.mkdirSync('stattedDir', { recursive: true });
const shape = (s) => [s.constructor.name, s instanceof fs.Stats, Object.keys(s).join(','), s.isFile(), s.isDirectory(), s.isSymbolicLink(), s.isCharacterDevice(), typeof s.mtime, s.mtime instanceof Date, s.size, s.blksize, s.blocks, typeof s.dev, typeof s.ino, s.nlink > 0];
show2('file', () => shape(fs.statSync('statted.txt')));
show2('dir', () => shape(fs.statSync('stattedDir')).slice(0, 6));
show2('dates lazy', () => { const s = fs.statSync('statted.txt'); const before = Object.keys(s).includes('mtime'); const m = s.mtime; return [before, Object.keys(s).includes('mtime'), m.getTime() === Math.round(s.mtimeMs)]; });
show2('bigint', () => { const s = fs.statSync('statted.txt', { bigint: true }); return [s.constructor.name, typeof s.size, typeof s.mtimeNs, s.isFile(), s instanceof fs.Stats, s.mtimeNs / 1000000n === s.mtimeMs]; });
show2('lstat bigint', () => fs.lstatSync('statted.txt', { bigint: true }).constructor.name);
// An epoch's milliseconds, exactly, in nanoseconds: 1700000000001 is no multiple of 4.
fs.utimesSync('statted.txt', new Date(1700000000001), new Date(1700000000001));
show2('bigint ms exact', () => BigInt(Math.trunc(fs.statSync('statted.txt').mtimeMs)) === fs.statSync('statted.txt', { bigint: true }).mtimeMs);
const throwing = { get bigint() { throw new Error('options read'); } };
show2('stat options throw', () => fs.stat('statted.txt', throwing, () => console.log('stat called back (should not)')));
show2('statSync options throw', () => fs.statSync('statted.txt', throwing));
show2('fstat bigint', () => { const fd = fs.openSync('statted.txt', 'r'); try { return fs.fstatSync(fd, { bigint: true }).constructor.name; } finally { fs.closeSync(fd); } });
show2('constants', () => [fs.F_OK, fs.R_OK, fs.W_OK, fs.X_OK, fs.F_OK === fs.constants.F_OK]);
show2('lchmod', () => [typeof fs.lchmod, typeof fs.lchmodSync, 'lchmod' in fs, typeof fs.promises.lchmod]);
show2('toUnixTimestamp', () => [fs._toUnixTimestamp(new Date(1500)), fs._toUnixTimestamp('12'), fs._toUnixTimestamp(3.5), fs._toUnixTimestamp(-1) > 1e9]);
show2('toUnixTimestamp bad', () => fs._toUnixTimestamp({}));
show2('Stats ctor', () => { const s = new fs.Stats(1, 0o100644, 1, 0, 0, 0, 4096, 1, 10, 1, 0, 0, 0, 0); return [s.isFile(), s.size, s instanceof fs.Stats]; });
(async () => {
  await new Promise((resolve) => fs.stat('statted.txt', { bigint: true }, (e, s) => { console.log('stat cb bigint: ' + (e ? e.code : s.constructor.name)); resolve(); }));
  console.log('promises bigint: ' + (await fs.promises.stat('statted.txt', { bigint: true })).constructor.name);
  try { await fs.promises.lchmod('statted.txt', 0o600); } catch (e) { console.log('promises lchmod: ' + e.code + ' ' + e.message); }
  const settled = fs.promises.stat('statted.txt', throwing).then(() => 'resolved', (e) => 'rejected ' + e.message);
  console.log('promises options throw: ' + await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve('pending'), 200))]));
})();
`,
  'dnsconst.cjs': String.raw`
const dns = require('dns');
const p = require('dns/promises');
const names = Object.keys(dns).filter((k) => /^[A-Z0-9_]+$/.test(k));
console.log(JSON.stringify(names.map((k) => [k, dns[k]])));
console.log(JSON.stringify(Object.keys(p).filter((k) => /^[A-Z0-9_]+$/.test(k)).map((k) => [k, p[k] === dns[k]])));
`,
  // The builtins workerd provides behind Node's argument checks
  // (node-builtin-fronts.ts): what they take still works as Node's does, and
  // the classes and globals keep their identities.
  'fronts.cjs': SHOW + String.raw`
const zlib = require('zlib');
const buffer = require('buffer');
const crypto = require('crypto');
const show2 = (label, f) => { try { const r = f(); console.log(label + ': ' + (typeof r === 'string' ? r : JSON.stringify(r))); } catch (e) { show(label, e); } };
// A DOMException's own keys are workerd's (node-builtin-errors-match-node-workerd records them).
const dom = (label, f) => { try { f(); console.log(label + ': no error'); } catch (e) { console.log(label + ': ' + e.constructor.name + ' ' + e.name + ' ' + e.code + ' ' + JSON.stringify(e.message)); } };
show2('zlib round trip', () => zlib.inflateSync(zlib.deflateSync('hello')).toString());
show2('zlib options ignored', () => zlib.gunzipSync(zlib.gzipSync('x', 5)).toString());
show2('zlib array buffer', () => zlib.inflateRawSync(new Uint8Array(zlib.deflateRawSync(Buffer.from('ab'))).buffer).toString());
show2('zlib brotli', () => zlib.brotliDecompressSync(zlib.brotliCompressSync('br')).toString());
show2('crc32', () => [zlib.crc32('abc'), zlib.crc32(Buffer.from('abc'), 7)]);
show2('crc32 value', () => zlib.crc32('abc', -1));
show2('isUtf8', () => [buffer.isUtf8(Buffer.from('é')), buffer.isUtf8(new Uint8Array([0xff])), buffer.isAscii(new Uint8Array([65]).buffer), buffer.isUtf8(new Uint16Array([0x4141]))]);
show2('isUtf8 dataview', () => buffer.isUtf8(new DataView(new ArrayBuffer(1))));
show2('transcode', () => buffer.transcode(Buffer.from('é'), 'utf8', 'latin1'));
show2('SlowBuffer', () => buffer.SlowBuffer(4).length);
// (Its upper bound is the platform's kMaxLength, workerd's 2 ** 31 - 1.)
show2('SlowBuffer string', () => buffer.SlowBuffer('4'));
show2('atob btoa', () => [atob(btoa('hi')), buffer.atob === atob, buffer.btoa === btoa, atob(' aGk= ')]);
dom('atob bad', () => atob('a=b='));
dom('atob one left', () => atob('abcde'));
dom('btoa wide', () => btoa('\u0100'));
show2('btoa symbol', () => btoa(Symbol('s')));
show2('Blob', () => { const b = new buffer.Blob(['ab', new Uint8Array([99])], { type: 'text/plain' }); return [b.size, b.type, b instanceof Blob, b.constructor === Blob, buffer.Blob === Blob, Blob.name]; });
show2('File', () => { const f = new buffer.File(['x'], 'a.txt'); return [f.name, f.size, f instanceof Blob, f instanceof File, f.constructor === File]; });
show2('Blob options', () => new Blob([], 5));
show2('Blob subclass', () => { class MyBlob extends Blob {} const b = new MyBlob(['z']); return [b instanceof MyBlob, b instanceof Blob, b.size]; });
show2('hash', () => [crypto.hash('sha1', 'abc'), crypto.createHmac('sha256', 'k').update('d').digest('hex').slice(0, 8)]);
show2('cipher', () => { const key = Buffer.alloc(32, 1); const iv = Buffer.alloc(16, 2); const c = crypto.createCipheriv('aes-256-cbc', key, iv); const enc = Buffer.concat([c.update(Buffer.from('secret')), c.final()]); const d = crypto.createDecipheriv('aes-256-cbc', key, iv); return Buffer.concat([d.update(enc), d.final()]).toString(); });
show2('cipher key object', () => crypto.createCipheriv('aes-128-cbc', crypto.createSecretKey(Buffer.alloc(16)), Buffer.alloc(16)).update(Buffer.from('x')).length);
show2('cipher wrong key object', () => { const { publicKey } = crypto.generateKeyPairSync('ed25519'); return crypto.createCipheriv('aes-128-ecb', publicKey, null); });
show2('secret key', () => [crypto.createSecretKey(Buffer.alloc(8)).symmetricKeySize, crypto.createSecretKey('abc', 'utf8').symmetricKeySize]);
show2('ecdh', () => crypto.createECDH('prime256v1').generateKeys().length);
show2('ecdh unknown', () => crypto.createECDH('nope'));
show2('dh group', () => crypto.getDiffieHellman('modp14').getPrime().length);
show2('dh unknown', () => crypto.createDiffieHellmanGroup('modp99'));
show2('random', () => [crypto.randomFillSync(Buffer.alloc(4)).length, crypto.randomInt(5) < 5, crypto.randomInt(2, 3), crypto.getRandomValues(new Uint8Array(2)).length]);
show2('randomInt range', () => crypto.randomInt(3, 2));
show2('randomInt too wide', () => crypto.randomInt(0, 2 ** 49));
dom('getRandomValues float', () => crypto.getRandomValues(new Float64Array(1)));
show2('timingSafeEqual', () => [crypto.timingSafeEqual(Buffer.from('a'), Buffer.from('a')), crypto.timingSafeEqual(new Uint8Array(1), new ArrayBuffer(1))]);
show2('timingSafeEqual length', () => crypto.timingSafeEqual(Buffer.from('a'), Buffer.from('ab')));
show2('timingSafeEqual buf2', () => crypto.timingSafeEqual(Buffer.from('a'), 'a'));
show2('pbkdf2Sync', () => crypto.pbkdf2Sync('p', 's', 1, 8, 'sha256').toString('hex'));
show2('pbkdf2 iterations', () => crypto.pbkdf2('p', 's', 0, 8, 'sha256', () => {}));
show2('pbkdf2 callback', () => crypto.pbkdf2('p', 's', 1, 8, 'sha256'));
show2('keys', () => { const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return [crypto.createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })).asymmetricKeyType, crypto.createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })).type,
    crypto.createPublicKey(privateKey).type, crypto.createPublicKey({ key: publicKey }).type]; });
show2('private key from key object', () => crypto.createPrivateKey(crypto.createSecretKey(Buffer.alloc(8))));
show2('sign no key', () => crypto.sign('sha256', Buffer.from('d')));
show2('verify array buffer', () => crypto.verify('sha256', new ArrayBuffer(1), 'k', Buffer.alloc(1)));
show2('rsa', () => { const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }); return crypto.privateDecrypt(privateKey, crypto.publicEncrypt(publicKey, Buffer.from('m'))).toString(); });
show2('rsa oaepHash', () => crypto.publicEncrypt({ key: 'k', oaepHash: 5 }, Buffer.from('m')));
show2('keygen options', () => crypto.generateKeySync('hmac'));
show2('keygen null options', () => crypto.generateKeyPairSync('ed25519', null));
show2('keygen', () => [crypto.generateKeySync('hmac', { length: 64 }).symmetricKeySize, crypto.generateKeyPairSync('ed25519').publicKey.asymmetricKeyType]);
show2('getCipherInfo', () => [crypto.getCipherInfo('aes-128-cbc').keyLength, crypto.getCipherInfo('nope')]);
show2('setEngine', () => crypto.setEngine('nimbus-none'));
show2('setEngine flags', () => crypto.setEngine('x', 'y'));
show2('sign verify', () => { const s = crypto.createSign('sha256'); s.update('d'); return typeof s.sign; });
show2('sign unknown', () => crypto.createSign('nope'));
(async () => {
  await new Promise((resolve) => crypto.generateKey('hmac', { length: 64 }, (e, k) => { console.log('generateKey: ' + (e ? e.code : k.symmetricKeySize)); resolve(); }));
  await new Promise((resolve) => crypto.pbkdf2('p', 's', 1, 8, 'sha256', (e, k) => { console.log('pbkdf2: ' + (e ? e.code : k.toString('hex'))); resolve(); }));
  await new Promise((resolve) => crypto.randomFill(new Uint8Array(4), (e, b) => { console.log('randomFill: ' + (e ? e.code : b.length)); resolve(); }));
  await new Promise((resolve) => crypto.randomInt(10, (e, n) => { console.log('randomInt cb: ' + (e ? e.code : n < 10)); resolve(); }));
})();
`,
  // Node's random fills past the Web Crypto quota (65536 bytes a call), as
  // its randomBytes, randomFillSync and randomFill take up to 2 ** 31 - 1;
  // every 65536-byte piece filled (a piece left zero would be a gap in the chunking).
  'random.cjs': SHOW + String.raw`
const crypto = require('crypto');
const show2 = (label, f) => { try { const r = f(); console.log(label + ': ' + (typeof r === 'string' ? r : JSON.stringify(r))); } catch (e) { show(label, e); } };
const dom = (label, f) => { try { f(); console.log(label + ': no error'); } catch (e) { console.log(label + ': ' + e.constructor.name + ' ' + e.name + ' ' + e.code); } };
const PIECE = 65536;
// Each piece's bytes (from \`from\` to \`to\`) hold a nonzero one.
const filled = (bytes, from = 0, to = bytes.length) => {
  for (let at = from; at < to; at += PIECE) {
    let any = false;
    for (let i = at; i < Math.min(to, at + PIECE); i++) if (bytes[i] !== 0) { any = true; break; }
    if (!any) return false;
  }
  return true;
};
const bytesOf = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
for (const size of [PIECE + 1, 1 << 20, 16 << 20]) {
  show2('randomBytes ' + size, () => { const b = crypto.randomBytes(size); return [b.length, Buffer.isBuffer(b), filled(b)]; });
  show2('randomFillSync ' + size, () => { const b = Buffer.alloc(size); const r = crypto.randomFillSync(b); return [r === b, filled(b)]; });
  show2('pseudoRandomBytes ' + size, () => crypto.pseudoRandomBytes(size).length);
}
show2('randomFillSync region', () => { const b = Buffer.alloc(3 * PIECE); const r = crypto.randomFillSync(b, PIECE / 2, 2 * PIECE); return [r === b, r.length, b.subarray(0, PIECE / 2).every((x) => x === 0), filled(b, PIECE / 2, PIECE / 2 + 2 * PIECE), b.subarray(PIECE / 2 + 2 * PIECE).every((x) => x === 0)]; });
show2('randomFillSync elements', () => { const u = new Uint32Array(PIECE); crypto.randomFillSync(u, 1, PIECE - 2); return [u[0], u[PIECE - 1], filled(bytesOf(u), 4, 4 * (PIECE - 1))]; });
show2('randomFillSync array buffer', () => { const a = new ArrayBuffer(PIECE * 2 + 7); return [crypto.randomFillSync(a) === a, filled(new Uint8Array(a))]; });
show2('randomFillSync small', () => crypto.randomFillSync(Buffer.alloc(10), 2, 3).length);
show2('randomFillSync offset range', () => crypto.randomFillSync(new Uint32Array(4), 5));
show2('randomFillSync size range', () => crypto.randomFillSync(new Uint32Array(4), 3, 2));
show2('randomFillSync offset type', () => crypto.randomFillSync(Buffer.alloc(4), 'x'));
show2('randomBytes too big', () => crypto.randomBytes(2 ** 31));
show2('randomBytes type', () => crypto.randomBytes('4'));
show2('randomFill callback', () => crypto.randomFill(Buffer.alloc(4), 0, 4));
dom('getRandomValues quota', () => crypto.getRandomValues(new Uint8Array(PIECE + 1)));
show2('getRandomValues quota words', () => { try { crypto.getRandomValues(new Uint8Array(PIECE + 1)); } catch (e) { return e.message; } });
dom('webcrypto quota', () => crypto.webcrypto.getRandomValues(new Uint8Array(PIECE + 1)));
dom('global quota', () => globalThis.crypto.getRandomValues(new Uint8Array(PIECE + 1)));
show2('getRandomValues at quota', () => crypto.getRandomValues(new Uint8Array(PIECE)).length);
(async () => {
  for (const size of [PIECE + 1, 1 << 20, 16 << 20]) {
    await new Promise((resolve) => crypto.randomBytes(size, (e, b) => { console.log('randomBytes cb ' + size + ': ' + (e ? e.code : [b.length, filled(b)])); resolve(); }));
    await new Promise((resolve) => crypto.randomFill(new Uint16Array(size / 2 >>> 0), (e, u) => { console.log('randomFill cb ' + size + ': ' + (e ? e.code : [u.length, filled(bytesOf(u))])); resolve(); }));
  }
  await new Promise((resolve) => crypto.randomFill(Buffer.alloc(3 * PIECE), PIECE, (e, b) => { console.log('randomFill offset cb: ' + (e ? e.code : [b.subarray(0, PIECE).every((x) => x === 0), filled(b, PIECE)])); resolve(); }));
  console.log('randomBytes promisified: ' + (await require('util').promisify(crypto.randomBytes)(PIECE + 1)).length);
})();
`,
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
// Each program's command line, after \`node\`.
const PROGRAMS = ['assert.cjs', 'util.cjs --from-argv', 'identity.cjs', 'mods/main.cjs', '-r ./mods/pre.cjs mods/plain.cjs', '- < mods/stdin.cjs', 'mods/throws.cjs', 'mods/esm/cache.cjs', 'sites.cjs', 'querystring.cjs', 'punycode.cjs', 'punycode-package.cjs', 'deprecate.cjs', 'os.cjs', 'perf.cjs', 'streamweb.cjs', 'timers.cjs', 'unref.cjs', 'process.cjs', 'capture.cjs', 'fsstats.cjs', 'dnsconst.cjs', 'fronts.cjs', 'random.cjs'];

const host = mkdtempSync(join(tmpdir(), 'node-lib-'));
process.on('exit', () => rmSync(host, { recursive: true, force: true }));
for (const [path, text] of Object.entries(FILES)) {
  mkdirSync(dirname(join(host, path)), { recursive: true });
  writeFileSync(join(host, path), text);
}
const expected = new Map(PROGRAMS.map((program) => {
  const ran = spawnSync('sh', ['-c', `node ${program}`], { cwd: host, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: host } });
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
    const bound = await session.run(`cd ${W} && node aborted-bound.cjs 2>&1`, 120_000);
    const line = splitScenarioOutput(bound.stdout).lines.find((l) => l.startsWith('BOUND '));
    assert.deepEqual(line && JSON.parse(line.slice(6)), { followers: 1, settled: 1000 }, `util.aborted keeps one follower per signal: ${bound.stdout.slice(-400)}`);
    const locked = await session.run(`cd ${W} && node locked.cjs 2>&1`, 120_000);
    assert.ok(splitScenarioOutput(locked.stdout).lines.includes('LOCKED []'), `a locked Error reads no sites: ${locked.stdout.slice(-400)}`);
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
