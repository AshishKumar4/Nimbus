#!/usr/bin/env bun
// A response with a null body status crosses each virtual HTTP path as it
// crosses Node's and curl's, though a Response refuses a body for one, an
// empty one included (audit RTM-9): a session's own server answers 204, 205
// and 304 to the shell's curl, and to another node program's http.get, which
// reaches it through its host. The oracle is the same server and client
// programs run by host Node, and the host's curl.
//
// Red before: the kernel rebuilt a 205 with the empty body its server ended,
// and the realm's loopback route did the same with the empty text it was
// handed: the Response constructor refused both, so curl failed to connect
// and http.get with ECONNREFUSED. Bun's Response takes a body for any
// status, so only Node's (and workerd's) shows it: run by bun, the test
// checks the source under Bun, then runs itself under node against the
// built package (packages/core/dist: rebuild first), whose realm is a Node
// worker thread.

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

const STATUSES = [200, 204, 205, 304];
const SERVER = `const server = require('http').createServer((q, s) => { s.writeHead(Number(q.url.slice(1))); s.end(); });
server.listen(Number(process.argv[2]), '127.0.0.1', () => console.log('listening ' + server.address().port));`;
const CLIENT = `const get = (status) => new Promise((resolve) => {
  require('http').get(process.argv[2] + '/' + status, (m) => {
    let body = '';
    m.on('data', (c) => { body += c; });
    m.on('end', () => resolve([status, m.statusCode, body]));
  }).on('error', (e) => resolve([status, e.code ?? e.message]));
});
(async () => { const out = []; for (const status of ${JSON.stringify(STATUSES)}) out.push(await get(status)); console.log(JSON.stringify(out)); })();`;
const CURL = (base, status) => ['-s', '-o', '/dev/null', '-w', '%{http_code}\\n', `${base}/${status}`];

// ── The oracle: host Node serves, host Node's http.get and host curl ask ──
const host = mkdtempSync(join(tmpdir(), 'null-body-'));
writeFileSync(join(host, 'server.js'), SERVER);
writeFileSync(join(host, 'client.js'), CLIENT);
const server = spawn('node', [join(host, 'server.js'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
let expected;
try {
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { const m = /listening (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    server.on('error', reject);
    server.on('exit', (code) => reject(new Error(`host server exited ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  // Spawned, not spawnSync: the host server answers from its own process, but this one must keep reading its pipe.
  const ask = (argv) => new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
  const client = await ask(['node', join(host, 'client.js'), base]);
  assert.equal(client.code, 0);
  const curl = [];
  for (const status of STATUSES) curl.push(await ask(['curl', ...CURL(base, status)]));
  expected = { client: JSON.parse(client.out), curl };
} finally {
  server.kill();
  rmSync(host, { recursive: true, force: true });
}
// What the oracle says, stated, so the comparison below is not vacuous.
assert.deepEqual(expected.client, [[200, 200, ''], [204, 204, ''], [205, 205, ''], [304, 304, '']]);
assert.deepEqual(expected.curl.map(({ code, out }) => [code, out]), [[0, '200\n'], [0, '204\n'], [0, '205\n'], [0, '304\n']]);

// ── The session: its node serves, another node program and curl ask ──────
const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const run = async (command, options = {}) => {
  const result = await ws.exec(command, { cwd: '/home/user', ...options });
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
};
await ws.fs.writeFile('/home/user/server.js', SERVER);
await ws.fs.writeFile('/home/user/client.js', CLIENT);
const stop = new AbortController();
const served = run('node server.js 8131', { signal: stop.signal });
try {
  for (let waited = 0; !ws.kernel.portRegistry.get(8131); waited += 50) {
    assert.ok(waited < 20_000, 'the session server listens');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const base = 'http://localhost:8131';
  const client = await run(`node client.js ${base}`, { signal: AbortSignal.timeout(20_000) });
  assert.equal(client.code, 0, client.err);
  assert.deepEqual(JSON.parse(client.out), expected.client, "another node program's http.get sees what host Node's does");
  for (const [i, status] of STATUSES.entries()) {
    const curl = await run(`curl ${CURL(base, status).map((word) => `'${word}'`).join(' ')}`);
    assert.deepEqual([curl.code, curl.out], [expected.curl[i].code, expected.curl[i].out], `curl ${status}: ${curl.err}`);
  }
} finally {
  stop.abort();
  await served;
  await ws.close();
}

if (underBun) {
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - virtual-http-null-body (204, 205 and 304 from a session server reach curl and another program\'s http.get as Node\'s reach them; under Bun and Node)');
} else {
  console.log('ok - under node');
}
