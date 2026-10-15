#!/usr/bin/env bun
// A lifo CommonJS command's http messages are Readables, as Node's are: a
// server reads a request's body with setEncoding and 'data', a client reads
// a response with for-await (Buffer chunks) and can pipe it. The same
// program run by real Node, against a real server, is the oracle.
//
// Red before: IncomingMessage was an EventEmitter that emitted strings:
// no pipe, no async iterator, setEncoding a no-op.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createLifoCommand } from '../../packages/core/src/substrate/lifo/pkg/lifo-runtime.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const PROGRAM = `
const http = require('http');
const { Readable, Writable } = require('stream');
module.exports = async () => {
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
writeFileSync(join(dir, 'run.js'), "require('./program.js')().then((code) => process.exit(code));\n");
const node = spawnSync('node', ['run.js'], { cwd: dir, encoding: 'utf8' });
assert.equal(node.status, 0, node.stderr);

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
try {
  await ws.fs.mkdir('/home/user/pkg', { recursive: true });
  await ws.fs.writeFile('/home/user/pkg/program.js', PROGRAM);
  ws.registry.register('program', createLifoCommand('/home/user/pkg/program.js', ws.filesystem.view({ pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } })));
  const r = await ws.exec('program', { cwd: '/home/user' });
  assert.deepEqual([r.exitCode, r.stdout, r.stderr], [0, node.stdout, ''], 'what node prints');
} finally {
  await ws.close();
}
console.log('lifo-http-incoming-readable: ok');
