#!/usr/bin/env bun
// A Node program's http client, asking a server of the same program, gets
// the response the server ends with, as Node's does: the client waits for
// res.end(), however late the handler calls it, and sees its status and
// reason, its headers and its body. The server sees the request's header
// names lower-cased, as Node gives them.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const failures = [];
const check = async (what, run) => {
  try { await run(); console.log(`  ✓ ${what}`); } catch (error) { failures.push(what); console.log(`  ✗ ${what}: ${error.message}`); }
};
/** Run `handler` as the server's request handler on `port`, ask it once, and print what the client saw. */
const exchange = async (port, handler, headers = {}) => {
  await ws.fs.writeFile('/tmp/exchange.js', `
const http = require('http');
const server = http.createServer(${handler});
server.listen(${port}, () => {
  http.get({ host: '127.0.0.1', port: ${port}, path: '/p?q=1', headers: ${JSON.stringify(headers)} }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      console.log(JSON.stringify({ status: res.statusCode, reason: res.statusMessage, late: res.headers['x-late'] ?? null, body }));
      server.close();
    });
  }).on('error', (error) => { console.log('error ' + error.message); server.close(); });
});
`);
  const r = await ws.exec('node /tmp/exchange.js', { timeout: 20_000 });
  assert.equal(r.stderr, '');
  assert.equal(r.exitCode, 0);
  return JSON.parse(r.stdout);
};

try {
  await check('a handler that ends from a timer: the client gets its status, headers and body', async () => {
    const got = await exchange(4501, `(req, res) => setTimeout(() => { res.statusCode = 201; res.setHeader('X-Late', 'yes'); res.end('late'); }, 30)`);
    assert.deepEqual(got, { status: 201, reason: 'Created', late: 'yes', body: 'late' });
  });

  await check('a handler that ends after awaiting: the same', async () => {
    const got = await exchange(4502, `async (req, res) => { await new Promise((r) => setTimeout(r, 10)); res.writeHead(202, { 'X-Late': 'awaited' }); res.end('after'); }`);
    assert.deepEqual(got, { status: 202, reason: 'Accepted', late: 'awaited', body: 'after' });
  });

  await check('a handler that ends at once: its reason is the status\'s', async () => {
    const got = await exchange(4503, `(req, res) => { res.statusCode = 404; res.end('nf'); }`);
    assert.deepEqual(got, { status: 404, reason: 'Not Found', late: null, body: 'nf' });
  });

  await check('the server sees the request\'s header names lower-cased', async () => {
    const got = await exchange(4504, `(req, res) => res.end(String(req.headers['x-custom']) + ' ' + req.url)`, { 'X-Custom': 'v' });
    assert.equal(got.body, 'v /p?q=1');
  });
} finally {
  await ws.close();
}

assert.deepEqual(failures, []);
console.log('node http virtual completion: ok');
