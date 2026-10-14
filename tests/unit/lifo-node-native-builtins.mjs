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
  'intercept.js': probes([
    "const util = require('util');",
    'const original = process.emitWarning;',
  ], [
    "process.emitWarning = (...args) => console.log('intercepted', args[0], args[1], args[2]); util.deprecate(() => 1, 'old api', 'DEP_X')(); process.emitWarning = original;",
    "const w = new Error('plain'); w.toString = undefined; process.emitWarning(w);",
    "const v = new Error('custom'); v.toString = () => 'CustomText'; process.emitWarning(v);",
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
