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
const PROGRAMS = ['assert.cjs', 'util.cjs --from-argv', 'identity.cjs', 'mods/main.cjs', '-r ./mods/pre.cjs mods/plain.cjs', '- < mods/stdin.cjs', 'mods/throws.cjs', 'mods/esm/cache.cjs', 'sites.cjs', 'querystring.cjs', 'punycode.cjs', 'punycode-package.cjs', 'deprecate.cjs'];

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
