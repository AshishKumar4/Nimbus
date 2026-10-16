#!/usr/bin/env bun
// A session server's reason phrase reaches its clients as Node's server
// sends it (ticket-lifo-status-text): its status's phrase from Node's whole
// table ('unknown' for one Node does not name), or the one its handler
// named (writeHead's reason, statusMessage). The shell's curl -i prints it,
// and another node program's http.get reads it as statusMessage, through
// its host. And a listen callback is called as Node calls it, the server
// its `this`. The oracle is the same server and client programs run by host
// Node, and the host's curl.
//
// Red before: the kernel's table held 18 statuses and ignored the handler's
// reason (curl printed "HTTP/1.1 205" and "HTTP/1.1 200 OK" for a 200
// "Fine By Me"), the realm carried no reason at all (http.get read ''), and
// `this` in a listen callback was undefined, so the server's program threw.
// Run by bun, the test checks the source under Bun, then runs itself under
// node against the built package (packages/core/dist: rebuild first).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';

const underBun = typeof process.versions.bun === 'string';
const { NimbusWorkspace } = await import(underBun
  ? '../../packages/core/src/workspace/nimbus-workspace.ts'
  : '../../packages/core/dist/workspace/nimbus-workspace.js');

const PATHS = ['status/200', 'status/201', 'status/205', 'status/206', 'status/299', 'status/418', 'status/429', 'status/451', 'status/599', 'reason/x', 'message/x'];
const SERVER = `const server = require('http').createServer((q, s) => {
  const [, kind, arg] = q.url.split('/');
  if (kind === 'reason') { s.writeHead(200, 'Fine By Me'); s.end(); return; }
  if (kind === 'message') { s.statusCode = 202; s.statusMessage = 'Custom'; s.end(); return; }
  s.writeHead(Number(arg)); s.end();
});
server.listen(Number(process.argv[2]), '127.0.0.1', function () { console.log('listening ' + this.address().port + ' ' + (this === server)); });`;
const CLIENT = `const get = (path) => new Promise((resolve) => {
  require('http').get(process.argv[2] + '/' + path, (m) => { m.resume(); m.on('end', () => resolve([path, m.statusCode, m.statusMessage])); })
    .on('error', (e) => resolve([path, e.code ?? e.message]));
});
(async () => { const out = []; for (const path of ${JSON.stringify(PATHS)}) out.push(await get(path)); console.log(JSON.stringify(out)); })();`;
const firstLine = (text) => text.split('\n')[0].replace(/\r$/, '');

// ── The oracle: host Node serves, host Node's http.get and host curl -i ask ──
const host = mkdtempSync(join(tmpdir(), 'status-line-'));
writeFileSync(join(host, 'server.js'), SERVER);
writeFileSync(join(host, 'client.js'), CLIENT);
const server = spawn('node', [join(host, 'server.js'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
let expected;
try {
  const [port, bound] = await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { const m = /listening (\d+) (\w+)/.exec(String(d)); if (m) resolve([Number(m[1]), m[2]]); });
    server.on('error', reject);
    server.on('exit', (code) => reject(new Error(`host server exited ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const ask = (argv) => new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
  const client = await ask(['node', join(host, 'client.js'), base]);
  const curl = [];
  for (const path of PATHS) curl.push(firstLine((await ask(['curl', '-si', `${base}/${path}`])).out));
  expected = { bound, client: JSON.parse(client.out), curl };
} finally {
  server.kill();
  rmSync(host, { recursive: true, force: true });
}
// What the oracle says, stated, so the comparison below is not vacuous.
assert.equal(expected.bound, 'true');
assert.deepEqual(expected.curl.slice(2, 5), ['HTTP/1.1 205 Reset Content', 'HTTP/1.1 206 Partial Content', 'HTTP/1.1 299 unknown']);
assert.deepEqual(expected.client.slice(-2), [['reason/x', 200, 'Fine By Me'], ['message/x', 202, 'Custom']]);

// ── The session: its node serves, another node program and curl -i ask ───
const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const run = async (command, options = {}) => {
  const result = await ws.exec(command, { cwd: '/home/user', ...options });
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
};
await ws.fs.writeFile('/home/user/server.js', SERVER);
await ws.fs.writeFile('/home/user/client.js', CLIENT);
const stop = new AbortController();
const served = run('node server.js 8132', { signal: stop.signal });
try {
  for (let waited = 0; !ws.kernel.portRegistry.get(8132); waited += 50) {
    assert.ok(waited < 20_000, 'the session server listens');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const base = 'http://localhost:8132';
  const client = await run(`node client.js ${base}`, { signal: AbortSignal.timeout(20_000) });
  assert.equal(client.code, 0, client.err);
  assert.deepEqual(JSON.parse(client.out), expected.client, "another node program's http.get reads what host Node's does");
  const curl = [];
  for (const path of PATHS) curl.push(firstLine((await run(`curl -si ${base}/${path}`)).out));
  assert.deepEqual(curl, expected.curl, 'curl -i prints the status line host curl prints');
} finally {
  stop.abort();
  const ended = await served;
  assert.match(ended.out, /^listening 8132 true$/m, 'the listen callback ran with the server as its this');
  await ws.close();
}

if (underBun) {
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - virtual-http-status-line (a session server\'s reason phrase reaches curl -i and another program\'s http.get as Node\'s does; listen\'s callback has its server; under Bun and Node)');
} else {
  console.log('ok - under node');
}
