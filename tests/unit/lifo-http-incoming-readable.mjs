#!/usr/bin/env bun
// lifo's http (node-compat/http.ts, what a lifo command's require('http')
// is) gives Readables, as Node's does: a server reads a request's body with
// setEncoding and 'data', a client reads a response with for-await (Buffer
// chunks) and can pipe it. The same program run by real Node, against a real
// server, is the oracle; here its server is one on lifo's port map, as the
// lifo node's is.
//
// Red before: IncomingMessage was an EventEmitter that emitted strings:
// no pipe, no async iterator, setEncoding a no-op.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHttp } from '../../packages/core/src/substrate/lifo/node-compat/http.ts';

const PROGRAM = `
const { Readable, Writable } = require('stream');
module.exports = async (http) => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += typeof chunk + ':' + chunk; });
    req.on('end', () => res.end('got ' + req.method + ' ' + body + ' ' + (req instanceof Readable)));
  });
  await new Promise((resolve) => server.listen(38123, resolve));
  const ask = () => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: 38123, method: 'POST', path: '/x' }, resolve);
    request.on('error', reject);
    request.end('hello');
  });
  const first = await ask();
  const chunks = [];
  for await (const chunk of first) chunks.push(chunk);
  const second = await ask();
  let piped = '';
  await new Promise((resolve) => second.pipe(new Writable({ write(chunk, _enc, done) { piped += chunk; done(); } })).on('finish', resolve));
  process.stdout.write(JSON.stringify([first instanceof Readable, chunks.every((chunk) => Buffer.isBuffer(chunk)), Buffer.concat(chunks).toString(), piped]) + '\\n');
  server.close();
  return 0;
};
`;

const dir = mkdtempSync(join(tmpdir(), 'lifo-http-'));
writeFileSync(join(dir, 'program.js'), PROGRAM);
writeFileSync(join(dir, 'run.js'), "require('./program.js')(require('http')).then((code) => process.exit(code));\n");
const node = spawnSync('node', ['run.js'], { cwd: dir, encoding: 'utf8' });
assert.equal(node.status, 0, node.stderr);

const program = createRequire(import.meta.url)(join(dir, 'program.js'));
let printed = '';
const write = process.stdout.write;
process.stdout.write = (chunk) => { printed += chunk; return true; };
let code;
try {
  code = await program(createHttp(new Map()));
} finally {
  process.stdout.write = write;
}
assert.deepEqual([code, printed], [0, node.stdout], 'what node prints');
console.log('lifo-http-incoming-readable: ok');
