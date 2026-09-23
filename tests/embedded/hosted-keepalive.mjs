// A quiet resident process on a hosted runtime survives a minute of silence
// while its client stays attached.
//
// The platform evicts a Durable Object after about ten seconds with no event,
// and a resident's facet dies with it; the launch journal then re-drives the
// process as a new boot. The hosted runtime asks its embedder for a
// `resident-keepalive` alarm while a resident runs. The server answers with a
// token drawn at boot, so the same token after the silence means the same
// process lived through it, in the same object instance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.BASE;
const token = process.env.NIMBUS_PROBE_TOKEN;
assert.ok(base && token, 'BASE and NIMBUS_PROBE_TOKEN must name the isolated library-host fixture');
const SILENCE_MS = Number(process.env.KEEPALIVE_SILENCE_MS || 70_000);
const PORT = 3031;
const workspace = `keepalive-${randomUUID()}`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function json(path, method = 'GET', body) {
  const response = await fetch(`${base}/workspaces/${workspace}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  assert.ok(response.ok, `${path}: ${response.status} ${text}`);
  return JSON.parse(text);
}
async function until(read, accept, message) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
async function bootToken() {
  const result = await json('/exec', 'POST', { command: `curl -fsS http://localhost:${PORT}/` });
  assert.equal(result.exitCode, 0, `curl failed: ${result.stderr}`);
  return result.stdout.trim();
}

let socket;
try {
  // The attached terminal is the present client the keep-alive re-arms on.
  socket = new WebSocket(`${base.replace(/^http/, 'ws')}/workspaces/${workspace}/ws`, { headers });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('terminal never became ready')), 60_000);
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string' && event.data.includes('"ready"')) { clearTimeout(timer); resolve(); }
    });
    socket.addEventListener('error', () => reject(new Error('terminal socket failed')));
  });

  await json('/file', 'PUT', {
    path: '/home/user/quiet.js',
    content: `const boot = require('node:crypto').randomUUID();
require('node:http').createServer((req, res) => res.end(boot)).listen(${PORT});`,
  });
  await json('/start', 'POST', { command: 'node /home/user/quiet.js' });
  const started = await until(() => json('/state'), (state) => state.ports.some((p) => p.port === PORT), 'the server never bound');
  const pid = started.ports.find((p) => p.port === PORT).pid;
  const first = await bootToken();
  const before = await json('/state');
  console.log(`resident pid=${pid} boot=${first} generation=${before.generation}; silent for ${SILENCE_MS} ms`);

  await new Promise((resolve) => setTimeout(resolve, SILENCE_MS));

  const after = await json('/state');
  console.log(`after silence: generation=${after.generation} keepalive=${JSON.stringify(after.scheduled.filter((t) => t.reason === 'resident-keepalive'))}`);
  assert.equal(after.generation, before.generation, 'the object was not evicted and re-instantiated');
  const second = await bootToken();
  console.log(`after silence: boot=${second}`);
  assert.equal(second, first, 'the original process answered, not a re-driven boot');
  assert.ok(after.processes.some((p) => p.pid === pid && p.state === 'running'), `pid ${pid} still running`);
  console.log('hosted-keepalive PASS');
} finally {
  socket?.close();
  await fetch(`${base}/workspaces/${workspace}/destroy`, { method: 'DELETE', headers }).catch(() => {});
}
