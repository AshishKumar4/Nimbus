#!/usr/bin/env bun
// Behavior test: the virtual socket kernel's outbound half. A guest runtime
// (Pyodide's socket.py, ruby.wasm's socket.rb) dials an in-session port by
// writing HTTP/1.1 request bytes onto a connect() connection; the kernel parses
// them, hands the Request to the supervisor's routeLoopback — the same routing
// the shell's curl and node's patched fetch use — and streams the Response back
// as response bytes. This asserts that byte-level contract, since that is
// exactly what the guest socket shims see.

import assert from 'node:assert/strict';
import { installVirtualSocketKernel } from '../../packages/worker/src/runtime/virtual-socket-kernel.ts';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Fresh kernel + a scriptable loopback router, isolated per case. */
function makeKernel(route) {
  const scope = { __nimbusVirtualSocketRouteLoopback: route };
  return { kernel: installVirtualSocketKernel(scope), scope };
}

const bytes = (id, kernel) => Uint8Array.from(kernel.recv(id, 1 << 20));

/** Drain a client connection to EOF through the suspending read. */
async function readAll(kernel, id) {
  const chunks = [];
  for (;;) {
    const chunk = await kernel.recvAsync(id, 1 << 16);
    if (chunk.length === 0) break;
    chunks.push(Uint8Array.from(chunk));
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return decoder.decode(out);
}

/** Split raw HTTP/1.1 response bytes into head + dechunked body. */
function parseWire(wire) {
  const split = wire.indexOf('\r\n\r\n');
  assert.ok(split > 0, `no header terminator in ${JSON.stringify(wire.slice(0, 200))}`);
  const head = wire.slice(0, split);
  let rest = wire.slice(split + 4);
  if (!/^transfer-encoding:\s*chunked/im.test(head)) return { head, body: rest };
  let body = '';
  for (;;) {
    const eol = rest.indexOf('\r\n');
    const size = parseInt(rest.slice(0, eol), 16);
    if (!Number.isFinite(size)) throw new Error(`bad chunk size in ${JSON.stringify(rest.slice(0, 40))}`);
    if (size === 0) break;
    body += rest.slice(eol + 2, eol + 2 + size);
    rest = rest.slice(eol + 2 + size + 2);
  }
  return { head, body };
}

// ── GET reaches the port and returns the body byte-exact ──────────────
{
  const seen = [];
  const { kernel } = makeKernel(async (port, request) => {
    seen.push({ port, url: request.url, method: request.method });
    return new Response('hello from node server.js', {
      status: 200,
      headers: { 'content-type': 'text/plain', 'x-served-by': 'user-server' },
    });
  });

  const id = kernel.connect(3000);
  kernel.send(id, encoder.encode('GET /api/items?q=1 HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nAccept: */*\r\n\r\n'));
  const { head, body } = parseWire(await readAll(kernel, id));

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { port: 3000, url: 'http://127.0.0.1:3000/api/items?q=1', method: 'GET' });
  assert.match(head, /^HTTP\/1\.1 200 /);
  assert.match(head, /x-served-by: user-server/i);
  assert.match(head, /Connection: close/i);
  assert.equal(body, 'hello from node server.js');
  kernel.close(id);
}

// ── POST carries its body through to the listening port ───────────────
{
  let received = null;
  const { kernel } = makeKernel(async (_port, request) => {
    received = { method: request.method, ctype: request.headers.get('content-type'), body: await request.text() };
    return Response.json({ ok: true, echoed: JSON.parse(received.body) });
  });

  const payload = JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] });
  const id = kernel.connect(8790);
  kernel.send(id, encoder.encode(
    `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:8790\r\n` +
    `Content-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`,
  ));
  const { head, body } = parseWire(await readAll(kernel, id));

  assert.deepEqual(received, { method: 'POST', ctype: 'application/json', body: payload });
  assert.match(head, /^HTTP\/1\.1 200 /);
  assert.deepEqual(JSON.parse(body), { ok: true, echoed: JSON.parse(payload) });
  kernel.close(id);
}

// ── The request may arrive in arbitrarily small writes ────────────────
{
  let seenBody = null;
  const { kernel } = makeKernel(async (_port, request) => {
    seenBody = await request.text();
    return new Response('ok');
  });
  const raw = 'PUT /x HTTP/1.1\r\nHost: localhost:5000\r\nContent-Length: 5\r\n\r\nabcde';
  const id = kernel.connect(5000);
  for (const ch of encoder.encode(raw)) kernel.send(id, Uint8Array.of(ch));
  const { body } = parseWire(await readAll(kernel, id));
  assert.equal(seenBody, 'abcde');
  assert.equal(body, 'ok');
  kernel.close(id);
}

// ── A streamed response is delivered incrementally, not buffered ──────
{
  let push;
  const stream = new ReadableStream({ start(c) { push = c; } });
  const { kernel } = makeKernel(async () => new Response(stream, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  }));

  const id = kernel.connect(8790);
  kernel.send(id, encoder.encode('GET /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:8790\r\n\r\n'));

  // Head arrives before the body producer emits anything.
  let wire = '';
  for (let i = 0; i < 50 && !wire.includes('\r\n\r\n'); i++) {
    wire += decoder.decode(Uint8Array.from(await kernel.recvAsync(id, 1 << 16)));
  }
  assert.match(wire, /transfer-encoding: chunked/i);

  push.enqueue(encoder.encode('data: one\n\n'));
  const first = decoder.decode(Uint8Array.from(await kernel.recvAsync(id, 1 << 16)));
  assert.match(first, /data: one/, 'first SSE event must arrive before the stream ends');

  push.close();
  const tail = await readAll(kernel, id);
  assert.match(tail, /^0\r\n\r\n$|0\r\n\r\n$/, 'chunked terminator must close the body');
  kernel.close(id);
}

// ── An unreachable port surfaces the router's error as an HTTP status ─
{
  const { kernel } = makeKernel(async () => { throw new Error('connection refused on port 9999'); });
  const id = kernel.connect(9999);
  kernel.send(id, encoder.encode('GET / HTTP/1.1\r\nHost: 127.0.0.1:9999\r\n\r\n'));
  const { head, body } = parseWire(await readAll(kernel, id));
  assert.match(head, /^HTTP\/1\.1 502 /);
  assert.match(body, /connection refused on port 9999/);
  kernel.close(id);
}

// ── Non-HTTP bytes fail loudly instead of hanging ─────────────────────
{
  const { kernel } = makeKernel(async () => new Response('unused'));
  const id = kernel.connect(6379);
  kernel.send(id, encoder.encode('*1\r\n$4\r\nPING\r\n\r\n'));
  const { head, body } = parseWire(await readAll(kernel, id));
  assert.match(head, /^HTTP\/1\.1 400 /);
  assert.match(body, /malformed HTTP request line/);
  kernel.close(id);
}

// ── connect() without a loopback router is a clear error, not a hang ──
{
  const kernel = installVirtualSocketKernel({});
  assert.throws(() => kernel.connect(3000), /loopback sockets are unavailable/);
}

// ── HEAD gets headers and no body ─────────────────────────────────────
{
  const { kernel } = makeKernel(async () => new Response('body that must not be sent', {
    status: 200, headers: { 'content-type': 'text/plain' },
  }));
  const id = kernel.connect(3000);
  kernel.send(id, encoder.encode('HEAD / HTTP/1.1\r\nHost: 127.0.0.1:3000\r\n\r\n'));
  const wire = await readAll(kernel, id);
  const { head, body } = parseWire(wire);
  assert.match(head, /^HTTP\/1\.1 200 /);
  assert.doesNotMatch(head, /transfer-encoding/i);
  assert.equal(body, '');
  kernel.close(id);
}

// ── The inbound (server) half still behaves — no regression ───────────
{
  const scope = {};
  const kernel = installVirtualSocketKernel(scope);
  scope.__nimbusVirtualSocketRequestQueued = () => {
    const conn = kernel.acceptNow(4000);
    const request = decoder.decode(bytes(conn.id, kernel));
    assert.match(request, /^GET \/ping HTTP\/1\.1/);
    kernel.send(conn.id, encoder.encode('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\npong'));
    return true;
  };
  kernel.listen(4000);
  const response = await kernel.handleHttpRequest(4000, new Request('http://127.0.0.1:4000/ping'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'pong');
}

console.log('virtual-socket-loopback-client: all tests passed');
