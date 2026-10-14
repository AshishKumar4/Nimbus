#!/usr/bin/env bun
// The shell's built-in node gives a program the engine's own crypto,
// string_decoder, util and buffer, and its console writes what Node's does
// (X-3): a program run through the public workspace API writes exactly what
// real `node` writes running it, its stderr included. CommonJS and an ES
// module's `node:` imports alike. Under Bun against the source, then under
// node against the built package (packages/core/dist: rebuild first).
//
// Red before: lifo's handwritten engines answered. createHash('md5') was
// refused, util.inspect(new Map) wrote {}, a class instance lost its name, a
// hex StringDecoder decoded UTF-8, Buffer.from(s, 'latin1') went through
// UTF-8, and a digest was not a Buffer to Buffer.isBuffer.
//
// A warning is the program's, as Node delivers it to the process that raised
// it: a native builtin's (util.deprecate) and the program's own
// process.emitWarning reach its process's 'warning' listeners and are written
// on its stderr as Node writes them. Red before: under Node a native
// builtin's went to the realm's own process, the host's stderr, and lifo's
// emitWarning wrote "Warning: <message>" and told no listener. One process:
// a module's `process` is globalThis.process and require('process'), which
// were each a process of their own. A builtin's warning goes through the
// program's emitWarning as it is when the warning is raised (a program may
// replace it), and an Error warning whose toString is not callable is written
// as Error.prototype.toString writes it.
//
// The engine's own events (X3b): an emitter, the program's or lifo's
// (streams, watchers, requests, readline, the process itself), is the
// engine's EventEmitter, with errorMonitor, captureRejections, once() and an
// unheard 'error' thrown. Red before: lifo's EventEmitter had none of them,
// swallowed an unheard 'error', and the process was no emitter at all.
//
// The engine's own streams (X3c): fs read and write streams are the engine's
// ReadStream and WriteStream over the program's filesystem, Buffers in
// ranges and pieces as Node reads them, and stream/promises and
// stream/consumers are there; process.stdout is a Writable a stream may pipe
// into and leave open. Red before: lifo's streams pushed the whole file as one
// string, had no pipeline, from(), Transform or async iteration, and
// process.stdout was no stream.
//
// The engine's own path and url (X3d), against the program's working
// directory: path.resolve('x') is the program's cwd and x, as pathToFileURL
// of a relative path is. Red before: lifo's path resolved from /, dropped a
// trailing separator, and had no toNamespacedPath or matchesGlob; its url
// had no domainToASCII, urlToHttpOptions or legacy format options.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';

const underBun = typeof process.versions.bun === 'string';
const { NimbusWorkspace } = await import(underBun
  ? '../../packages/core/src/workspace/nimbus-workspace.ts'
  : '../../packages/core/dist/workspace/nimbus-workspace.js');

// Each probe on its own line, guarded: one a lifo engine refuses (its
// message written in the probe's place) leaves the others to be compared.
const probes = (head, lines) => [...head, 'const probe = (f) => { try { f(); } catch (e) { console.log(\'threw\', e.message); } };',
  ...lines.map((line) => `probe(() => { ${line} });`)].join('\n');

const programs = {
  'probe.js': probes([
    "const crypto = require('crypto');",
    "const util = require('util');",
    "const { StringDecoder } = require('string_decoder');",
    "const { Buffer: B } = require('buffer');",
    'class Point { constructor() { this.x = 1; this.y = [1, 2]; } }',
  ], [
    "console.log(crypto.createHash('md5').update('abc').digest('hex'));",
    "console.log(crypto.createHash('sha512').update('abc').digest('base64'));",
    "console.log(crypto.createHash('sha3-256').update('abc').digest('hex'));",
    "console.log(crypto.createHmac('sha256', 'key').update('abc').digest('hex'));",
    "console.log(crypto.hash('sha1', 'abc'));",
    "console.log(crypto.pbkdf2Sync('pw', 'salt', 2, 16, 'sha256').toString('hex'));",
    "console.log(Buffer.isBuffer(crypto.createHash('sha256').update('x').digest()), crypto.randomBytes(8).length);",
    "console.log(crypto.getHashes().includes('md5'), typeof crypto.webcrypto.subtle.digest);",
    "const hex = new StringDecoder('hex'); console.log(hex.write(Buffer.from([0xde, 0xad])) + hex.end(Buffer.from([0xbe])));",
    "const b64 = new StringDecoder('base64'); console.log(b64.write(Buffer.from('ab')) + '|' + b64.write(Buffer.from('c')) + '|' + b64.end());",
    "const u8 = new StringDecoder('utf8'); const euro = Buffer.from('€'); console.log(JSON.stringify([u8.write(euro.subarray(0, 1)), u8.write(euro.subarray(1)), u8.end(Buffer.from([0xe2]))]));",
    "const u16 = new StringDecoder('utf16le'); console.log(u16.write(Buffer.from('hi', 'utf16le').subarray(0, 3)) + u16.end(Buffer.from([0])));",
    "console.log(util.inspect(new Map([[1, { a: [1, 2] }], ['k', new Set(['v'])]])));",
    'console.log(util.inspect(new Point()), util.inspect({ a: { b: { c: { d: {} } } } }));',
    "console.log(util.inspect('str'), util.inspect([undefined, null, -0, 1n, Symbol('s')]));",
    "console.log(util.format('%s:%d:%j', 'a', 2, { b: 3 }), util.format('%o', [1]));",
    'console.log(util.types.isPromise(Promise.resolve()), util.isDeepStrictEqual({ a: [1] }, { a: [1] }), typeof util.promisify(setTimeout));',
    "console.log(util.inspect(new Error('boom')).split('\\n')[0]);",
    "console.log(B === Buffer, Buffer.from('héllo', 'latin1').toString('latin1'), Buffer.from('héllo', 'latin1').length);",
    "console.log(Buffer.from('ff00', 'hex').readUInt16BE(0), Buffer.byteLength('é'), Buffer.from('aGk=', 'base64').toString());",
    "console.log(Buffer.from('abc'), [Buffer.from([1, 2])]);",
    "console.log(new Map([[1, 'a']]), new Point(), [new Set([1])]);",
    'console.dir({ a: { b: { c: { d: 1 } } } }, { depth: 0 });',
    "console.log('%s and %o', 'x', { y: 1 });",
    "console.error(new Map([['e', 1]]));",
  ]),
  'probe.mjs': probes([
    "import { createHash } from 'node:crypto';",
    "import util, { inspect } from 'node:util';",
    "import { StringDecoder } from 'node:string_decoder';",
    "import { Buffer } from 'node:buffer';",
    "import nodeProcess from 'node:process';",
  ], [
    "console.log(createHash('md5').update('esm').digest('hex'));",
    "console.log(inspect(new Map([['m', 1]])), util.format('%i', '7px'));",
    "console.log(new StringDecoder('hex').write(Buffer.from([1, 255])), Buffer.from('é', 'latin1').length);",
    'console.log(nodeProcess === globalThis.process);',
  ]),
  'warnings.js': probes([
    "const util = require('util');",
    'console.log(process.listenerCount(\'warning\'), process === globalThis.process, process === require(\'process\'), process === require(\'node:process\'));',
    "process.on('warning', (w) => console.log('heard', w.name, w.code, w.message, w instanceof Error));",
  ], [
    "const old = util.deprecate(() => 1, 'old thing', 'DEP_NIMBUS'); old(); old();",
    "process.emitWarning('custom one', 'CustomWarning');",
    "process.emitWarning('with detail', { type: 'X', code: 'C1', detail: 'more' });",
    "process.emitWarning(new Error('as error'));",
    'process.emitWarning(5);',
  ]),
  'events.js': probes([
    "const EventEmitter = require('events');",
    "const { once, on, errorMonitor, getEventListeners } = require('events');",
  ], [
    "console.log(typeof once, typeof on, typeof errorMonitor, EventEmitter.EventEmitter === EventEmitter, EventEmitter.defaultMaxListeners, typeof EventEmitter.captureRejectionSymbol);",
    "const e = new EventEmitter(); e.on(errorMonitor, (err) => console.log('monitor', err.message)); e.emit('error', new Error('boom'));",
    "new EventEmitter().emit('error', 'not an error');",
    "const f = new EventEmitter(); f.once('x', () => {}); console.log(f.listeners('x').length, typeof f.rawListeners('x')[0].listener);",
    "const f = new EventEmitter(); f.on('newListener', (n) => console.log('new', String(n))); f.on('y', () => {}); f.prependOnceListener('y', () => {}); console.log(f.listenerCount('y'), f.eventNames());",
    "const g = new EventEmitter({ captureRejections: true }); g.on('error', (err) => console.log('captured', err.message)); g.on('z', async () => { throw new Error('async'); }); g.emit('z');",
    "once(new EventEmitter(), 'never', { signal: AbortSignal.abort() }).catch((err) => console.log('aborted', err.name));",
    "const h = new EventEmitter(); setTimeout(() => h.emit('ready', 1, 2)); once(h, 'ready').then((v) => console.log('once', v));",
    "const m = new EventEmitter(); for (let i = 0; i < 11; i++) m.on('many', () => {}); console.log(getEventListeners(m, 'many').length, EventEmitter.listenerCount(m, 'many'));",
    "class Mine extends EventEmitter {} const x = new Mine(); x.setMaxListeners(1); x.on('a', () => {}); x.on('a', () => {}); console.log(x.getMaxListeners());",
    "const s = require('stream'); console.log(new s.Readable() instanceof EventEmitter, new s.PassThrough() instanceof EventEmitter, s.Stream.prototype instanceof EventEmitter, s === s.Stream, new s.Readable() instanceof s, new s.Writable() instanceof s);",
    "const w = require('fs').watch('.', () => {}); console.log(w instanceof EventEmitter); w.close();",
    "console.log(require('http').request('http://127.0.0.1:1/').on('error', () => {}) instanceof EventEmitter);",
    "console.log(require('readline').createInterface({ input: new (require('stream').PassThrough)() }) instanceof EventEmitter);",
    "console.log(process instanceof EventEmitter, typeof process.prependOnceListener, process.getMaxListeners());",
    "require('child_process').exec('true'); console.log('exec without a callback');",
  ]),
  'intercept.js': probes([
    "const util = require('util');",
    'const original = process.emitWarning;',
  ], [
    "process.emitWarning = (...args) => console.log('intercepted', args[0], args[1], args[2]); util.deprecate(() => 1, 'old api', 'DEP_X')(); process.emitWarning = original;",
    "const w = new Error('plain'); w.toString = undefined; process.emitWarning(w);",
    "const v = new Error('custom'); v.toString = () => 'CustomText'; process.emitWarning(v);",
  ]),
  // Streams, one step after another so the order is the program's.
  'streams.js': [
    "const fs = require('fs');",
    "const stream = require('stream');",
    'const { Readable, Writable, PassThrough, Transform, Duplex, pipeline, finished } = stream;',
    "const step = (name, run) => new Promise((resolve) => { Promise.resolve().then(run).then(resolve, (e) => { console.log(name, 'threw', e.code, e.message); resolve(); }); });",
    '(async () => {',
    "  fs.writeFileSync('s.txt', 'héllo\\nworld\\n');",
    "  await step('chunks', () => new Promise((resolve) => fs.createReadStream('s.txt').on('data', (c) => console.log('chunk', Buffer.isBuffer(c), c.length)).on('end', () => { console.log('end'); resolve(); })));",
    "  await step('range', () => new Promise((resolve) => fs.createReadStream('s.txt', { encoding: 'utf8', start: 1, end: 4 }).on('data', (c) => console.log('range', JSON.stringify(c))).on('close', resolve)));",
    "  await step('setEncoding', () => new Promise((resolve) => { const r = fs.createReadStream('s.txt'); r.setEncoding('hex'); r.on('data', (c) => console.log('hex', c)); r.on('end', resolve); }));",
    "  await step('iterate', async () => { let n = 0; for await (const c of fs.createReadStream('s.txt', { highWaterMark: 4 })) n += c.length; console.log('iterated', n); });",
    "  await step('events', () => new Promise((resolve) => { const r = fs.createReadStream('s.txt'); const seen = []; for (const e of ['open', 'ready', 'end', 'close']) r.on(e, () => { seen.push(e); if (e === 'close') { console.log('events', seen.join(' '), r.bytesRead, r.pending); resolve(); } }); r.resume(); }));",
    "  await step('missing', () => new Promise((resolve) => fs.createReadStream('nope.txt').on('error', (e) => { console.log('missing', e.code, e.syscall); resolve(); })));",
    "  await step('from', async () => { const out = []; for await (const c of Readable.from(['a', 'b', 'c'])) out.push(c); console.log('from', out.join('')); });",
    "  await step('pipeline', () => new Promise((resolve) => pipeline(Readable.from(['x', 'y']), new Transform({ transform(c, e, cb) { cb(null, String(c).toUpperCase()); } }), fs.createWriteStream('o.txt'), (err) => { console.log('pipeline', err ?? null, fs.readFileSync('o.txt', 'utf8')); resolve(); })));",
    "  await step('promises', async () => { const { pipeline: pp } = require('stream/promises'); await pp(Readable.from(['p', 'q']), fs.createWriteStream('p.txt')); console.log('promises', fs.readFileSync('p.txt', 'utf8')); });",
    "  await step('append', () => new Promise((resolve) => { const w = fs.createWriteStream('o.txt', { flags: 'a' }); w.write('Z'); w.end('!', () => { console.log('append', fs.readFileSync('o.txt', 'utf8'), w.bytesWritten); resolve(); }); }));",
    "  await step('writable', () => new Promise((resolve) => { const got = []; const w = new Writable({ write(c, e, cb) { got.push(String(c)); cb(); } }); w.on('finish', () => { console.log('writable', got); resolve(); }); w.write('1'); w.end('2'); }));",
    "  await step('passthrough', () => new Promise((resolve) => { const p = new PassThrough(); p.on('data', (c) => console.log('pt', String(c))); p.on('end', resolve); p.end('through'); }));",
    "  await step('finished', () => new Promise((resolve) => { const r = Readable.from(['f']); finished(r, (err) => { console.log('finished', err ?? null); resolve(); }); r.resume(); }));",
    "  await step('duplex', () => { const d = new Duplex({ read() {}, write(c, e, cb) { cb(); } }); console.log('duplex', d instanceof Readable, d instanceof Writable, d.readable, d.writable); });",
    "  await step('classes', () => { console.log('classes', typeof fs.ReadStream, fs.createReadStream('s.txt').destroy() instanceof fs.ReadStream, fs.createWriteStream('c.txt').destroy() instanceof fs.WriteStream, typeof stream.compose, typeof stream.addAbortSignal, stream.Stream === stream); });",
    "  await step('consumers', async () => { const { text } = require('stream/consumers'); console.log('consumers', await text(Readable.from(['t', 'x']))); });",
    "  await step('tty', () => { const tty = require('tty'); console.log('tty', typeof tty.WriteStream, typeof tty.ReadStream, typeof tty.isatty); });",
    "  await step('stdout', () => new Promise((resolve) => { Readable.from(['to ', 'stdout\\n']).pipe(process.stdout).on('unpipe', () => { process.stdout.write('stdout still open\\n'); console.log('stdout', process.stdout instanceof Writable, process.stdout.writable); resolve(); }); }));",
    "  await step('fs option', () => new Promise((resolve) => { let n = 0; fs.createReadStream('s.txt', { fs: undefined }).on('data', (c) => { n += c.length; }).on('error', (e) => { console.log('fs option', e.code); resolve(); }).on('end', () => { console.log('fs option', n); resolve(); }); }));",
    "  await step('flush', () => new Promise((resolve) => { const w = fs.createWriteStream('f.txt', { flush: true }); w.end('flushed', () => { const v = fs.createWriteStream('g.txt', { flush: false }); v.end('kept', () => { console.log('flush', fs.readFileSync('f.txt', 'utf8'), fs.readFileSync('g.txt', 'utf8')); resolve(); }); }); }));",
    "  await step('encodings', () => { process.stdout.write('68690a', 'hex'); process.stdout.setDefaultEncoding('hex'); process.stdout.write('6f6b0a'); process.stdout.setDefaultEncoding('utf8'); process.stdout.write(Buffer.from([0xe2, 0x82])); process.stdout.write(Buffer.from([0xac, 0x0a])); });",
    "  await step('legacy', () => new Promise((resolve) => { const legacy = new stream.Stream(); legacy.readable = true; legacy.pipe(process.stdout); legacy.emit('data', 'legacy\\n'); legacy.emit('end'); setTimeout(() => { process.stdout.write('after legacy\\n'); resolve(); }, 10); }));",
    '})();',
  ].join('\n'),
  // Paths against the program's own working directory, written relative to it
  // (the two runs' directories differ).
  'paths.js': probes([
    "const path = require('path');",
    "const url = require('url');",
    'const here = (p) => (p.startsWith(process.cwd()) ? \'<cwd>\' + p.slice(process.cwd().length) : p);',
  ], [
    "console.log(path.normalize('/a/b/'), path.normalize('a//b/../c/'), path.join('a', 'b/'), path.join('', ''), path.dirname('/a/b/'), path.basename('/a/b/'), path.extname('.x'), path.isAbsolute('a'));",
    "console.log(here(path.resolve('x')), here(path.resolve('x/', '..', 'y/')), path.resolve('/r', 'x/'), here(path.resolve()), path.relative('x', 'y/z'), path.relative('/a/b', '/a'), path.relative(process.cwd(), path.resolve('n')));",
    "console.log(JSON.stringify(path.parse('/a/b.c.d')), path.format({ dir: 'x', name: 'y', ext: '.z' }), path.format({ root: '/', base: 'f' }), path.toNamespacedPath('/p'), typeof path.matchesGlob);",
    "console.log(path.posix === path, path.sep, path.delimiter, path.win32.sep, path.win32.join('a', 'b'), path.posix.resolve('/q', 'r'));",
    "console.log(here(url.fileURLToPath(url.pathToFileURL('rel dir/f#x?.js'))), url.pathToFileURL('rel dir/f#x?.js').href.endsWith('/rel%20dir/f%23x%3F.js'), url.pathToFileURL('/abs/').href, url.pathToFileURL('d/').href.endsWith('/d/'));",
    // Bun's url.parse is deprecated whatever it parses (Node's only for some): its warning is Bun's, not the question.
    "process.noDeprecation = true; const port = url.parse('http://a.com:80/p?q=1').port; process.noDeprecation = false; console.log(url.fileURLToPath('file:///a%20b'), url.format(new URL('http://u:p@h:1/p?q#f'), { auth: false }), port, url.resolve('http://a/b/c', '../d'), url.URL === URL, typeof url.domainToASCII, typeof url.urlToHttpOptions);",
    "url.fileURLToPath('http://x/');",
    "url.fileURLToPath('file:///a%2fb');",
  ]),
};
/** Node writes its pid in a warning: `(node:<pid>)`. */
const samePid = (text) => text.replace(/\(node:\d+\)/g, '(node:PID)');

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const host = mkdtempSync(join(tmpdir(), 'lifo-node-native-builtins-'));
const failed = [];
try {
  for (const [name, source] of Object.entries(programs)) {
    await ws.fs.writeFile(`/home/user/${name}`, source);
    writeFileSync(join(host, name), source);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_NO_WARNINGS' && key !== 'NODE_OPTIONS'));
    const node = spawnSync('node', [name], { cwd: host, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(node.status, 0, `real node runs ${name}: ${node.stderr}`);
    const lifo = await ws.exec(`node ${name}`, { cwd: '/home/user' });
    if (lifo.exitCode !== 0 || lifo.stdout !== node.stdout || samePid(lifo.stderr) !== samePid(node.stderr)) {
      const want = `${node.stdout}${samePid(node.stderr)}`.split('\n');
      const got = `${lifo.stdout}${samePid(lifo.stderr)}`.split('\n');
      const lines = want.flatMap((line, i) => (line === got[i] ? [] : [`  node: ${line}\n  lifo: ${got[i]}`]));
      failed.push(`${name} (exit ${lifo.exitCode}):\n${lines.join('\n')}`);
    }
  }
} finally {
  await ws.close();
  rmSync(host, { recursive: true, force: true });
}

if (underBun) {
  // Under node whatever Bun answered, so a red run shows both.
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 120_000 });
  assert.deepEqual(failed, [], `bun: lifo's node writes what real node writes:\n${failed.join('\n')}\n\nunder node (exit ${node.status}):\n${node.stdout}${node.stderr}`);
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - lifo-node-native-builtins (crypto, string_decoder, util, buffer, console as node writes them; under Bun and Node)');
} else {
  assert.deepEqual(failed, [], `node: lifo's node writes what real node writes:\n${failed.join('\n')}`);
  console.log('ok - under node');
}
