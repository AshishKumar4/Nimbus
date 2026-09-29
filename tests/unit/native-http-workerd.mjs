// @serial
// Compare the native guest HTTP bridge with Node's HTTP server: binary
// requests, pipe, streaming before end, HEAD/204, duplicate listen errors,
// closure and two independent ephemeral listeners. Also exercise Nimbus's
// parked-listener and response-header deadline around real workerd dispatch.
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_HTTP_SOURCE } from '../../packages/worker/src/runtime/native-http.ts';
import { ENTRYPOINT_EVENT_LOOP } from '../../packages/worker/src/facets/manager.ts';
import { clientLifetime, pendingListenLifetime, pendingCloseLifetime } from './lib/native-http-lifetimes.mjs';

async function exercise(http, serve) {
  const opened = [];
  const listen = async server => {
    opened.push(server);
    const ready = Promise.withResolvers();
    server.once('error', ready.reject);
    server.listen({ port: 0, host: '127.0.0.1' }, ready.resolve);
    await ready.promise;
    return server.address().port;
  };
  const finish = Promise.withResolvers();
  const server = http.createServer(async (req, res) => {
    if (req.url === '/pipe') { req.pipe(res); return; }
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.flushHeaders();
      res.write('first');
      await finish.promise;
      res.end('second');
      return;
    }
    if (req.url === '/dictionary') {
      const fields = Object.assign(Object.create(null), { 'x-dictionary': 'yes' });
      res.writeHead(202, fields); res.end('dictionary'); return;
    }
    if (req.url === '/empty') { res.statusCode = 204; res.end('ignored'); return; }
    if (req.url === '/echo') {
      const parts = [];
      let buffers = true;
      for await (const part of req) { buffers &&= Buffer.isBuffer(part); parts.push(part); }
      const bytes = Buffer.concat(parts);
      res.end(JSON.stringify({ buffers, bytes: Array.from(bytes), native: req instanceof http.IncomingMessage && res instanceof http.ServerResponse }));
      return;
    }
    res.writeHead(201, { 'x-list': ['one', 'two'] });
    res.end('body');
  });
  try {
    const port = await listen(server);
    const request = (path, init = {}) => serve(port, new Request('http://loopback' + path, init));
    const bytes = new Uint8Array([0, 128, 255, 13, 10, 195, 169]);
    const echo = await (await request('/echo', { method: 'POST', body: bytes })).json();
    const pipe = new Uint8Array(await (await request('/pipe', { method: 'POST', body: bytes })).arrayBuffer());
    const head = await request('/status', { method: 'HEAD' });
    const empty = await request('/empty');
    const dictionaryResponse = await request('/dictionary');
    const dictionary = [dictionaryResponse.status, dictionaryResponse.headers.get('x-dictionary'), await dictionaryResponse.text()];
    const stream = await request('/stream');
    const reader = stream.body.getReader();
    const first = await reader.read();
    finish.resolve();
    let rest = '';
    for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
    const duplicate = http.createServer();
    const error = Promise.withResolvers();
    duplicate.once('error', error.resolve);
    duplicate.listen(port);
    const duplicateCode = (await error.promise).code;
    const parked = http.createServer();
    const otherPort = await listen(parked);
    const waiting = serve(otherPort, new Request('http://loopback/parked'));
    queueMicrotask(() => parked.on('request', (_q, s) => s.end('attached-later')));
    const parkedBody = await (await waiting).text();
    const closed = Promise.withResolvers();
    server.close(closed.resolve);
    await closed.promise;
    return {
      dictionary,
      echo, pipe: Array.from(pipe), allocated: port > 0 && otherPort > 0 && port !== otherPort,
      head: [head.status, await head.text(), head.headers.get('x-list').split(',').map(s => s.trim())],
      empty: [empty.status, await empty.text()], stream: [new TextDecoder().decode(first.value), rest],
      duplicateCode, parkedBody, closed: server.address() === null,
    };
  } finally {
    finish.resolve();
    for (const s of opened) { if (s.listening) s.close(); }
  }
}

const node = spawnSync('node', ['--input-type=module', '-e', `
  import http from 'node:http';
  const exercise = ${exercise.toString()};
  const result = await exercise(http, (port, request) => {
    const url = new URL(request.url); url.hostname = '127.0.0.1'; url.port = String(port);
    return fetch(url, { method: request.method, headers: request.headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, duplex: 'half' });
  });
  console.log(JSON.stringify(result));
`], { encoding: 'utf8', timeout: 30000 });
assert.equal(node.status, 0, node.stderr);
const expected = JSON.parse(node.stdout);
assert.equal(expected.duplicateCode, 'EADDRINUSE');
assert.equal(expected.allocated, true);
assert.deepEqual(expected.stream, ['first', 'second']);

const require = createRequire(import.meta.url);
const fromWrangler = createRequire(require.resolve('wrangler/package.json'));
const binary = fromWrangler('workerd').default;
const dir = mkdtempSync(join(tmpdir(), 'nimbus-native-http-'));
const portReady = Promise.withResolvers();
const probePort = net.createServer(); probePort.listen(0, '127.0.0.1', portReady.resolve);
await portReady.promise;
const port = probePort.address().port;
const released = Promise.withResolvers(); probePort.close(released.resolve); await released.promise;
writeFileSync(join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "main", worker = (modules = [(name = "main.js", esModule = embed "main.js")], compatibilityDate = "2026-09-26", compatibilityFlags = ["nodejs_compat", "new_module_registry"]))], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]);`);
writeFileSync(join(dir, 'main.js'), `
import * as __real_http from 'node:http';
import * as __real_https from 'node:https';
import * as __real_net from 'node:net';
import { handleAsNodeRequest as __nimbusHandleAsNodeRequest } from 'cloudflare:node';
const builtins = {}, __pendingIO = [], registered = new Map();
let nextPort = 49152;
const __supervisor = {
  async allocatePort() { const port = nextPort++; registered.set(port, true); return port; },
  async registerPort(port) { registered.set(port, true); },
  async unregisterPort(port) { registered.delete(port); },
};
const __nimbusInboundBarrier = async () => {};
const __nimbusProcessExitPromise = Promise.withResolvers().promise;
globalThis.__nimbusRawSetTimeout = setTimeout;
${ENTRYPOINT_EVENT_LOOP}
${NATIVE_HTTP_SOURCE}
const exercise = ${exercise.toString()};
const clientLifetime = ${clientLifetime.toString()};
const pendingListenLifetime = ${pendingListenLifetime.toString()};
const pendingCloseLifetime = ${pendingCloseLifetime.toString()};
const drain = async () => { while (__pendingIO.length) await Promise.all(__pendingIO.splice(0)); };
export default { async fetch(request) {
  if (new URL(request.url).pathname === '/ready') return new Response('ready');
  const http = builtins.http;
  const mode = new URL(request.url).searchParams.get('case');
  if (mode === 'client' || mode === 'error' || mode === 'cancel') return Response.json(await clientLifetime(builtins.https, __nimbusRunEntrypointToExit, mode));
  if (mode === 'pending') return Response.json(await pendingListenLifetime(http, __nimbusRunEntrypointToExit, __supervisor, drain));
  if (mode === 'close') return Response.json(await pendingCloseLifetime(http, __supervisor, registered, drain));
  const result = await exercise(http, (port, request) => {
    const headers = new Headers(request.headers); headers.set('X-Nimbus-Port', String(port));
    return globalThis.__nimbusServeHttp(new Request(request, { headers }));
  });
  await Promise.all(__pendingIO.splice(0));
  return Response.json({ result, registered: [...registered.keys()] });
} };`);
const child = spawn(binary, ['serve', 'config.capnp', '--experimental'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
try {
  const until = Date.now() + 30000;
  for (;;) {
    try { await fetch(`http://127.0.0.1:${port}/ready`); break; } catch {}
    if (child.exitCode !== null || Date.now() >= until) throw new Error(logs);
    await Bun.sleep(30);
  }
  const response = await fetch(`http://127.0.0.1:${port}/run`, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, logs);
  const actual = await response.json();
  assert.deepEqual(actual.result, expected, logs);
  assert.deepEqual(actual.registered, [], 'closing native servers releases Nimbus ports');
  const snapshots = {};
  for (const mode of ['client', 'error', 'cancel', 'pending', 'close']) {
    const reply = await fetch(`http://127.0.0.1:${port}/run?case=${mode}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(reply.status, 200, logs);
    snapshots[mode] = await reply.json();
  }
  assert.deepEqual(snapshots, {
    client: { ended: true, errored: false, closed: true, streamed: true, body: 'firstsecond', cancelled: false, pending: 0 },
    error: { ended: false, errored: true, closed: true, streamed: true, body: 'first', cancelled: false, pending: 0 },
    cancel: { ended: false, errored: false, closed: true, streamed: true, body: 'first', cancelled: true, pending: 0 },
    pending: { listening: true, pending: 0 },
    close: { closes: 1, callbacks: 1, listening: true, relistenError: null, port: 55001, oldReleased: true, newRetained: true },
  }, 'the process may exit only after native I/O has completed, and pending close must permit a new listen');
  console.log('native-http-workerd: Node parity for binary, streams, HEAD/204, listen errors and lifecycle');
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  rmSync(dir, { recursive: true, force: true });
}
