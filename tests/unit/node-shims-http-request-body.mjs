#!/usr/bin/env bun
// Behavior test: a resident node server can read a POST body.
//
// Node delivers a request body as Buffers on an IncomingMessage that is a
// Readable stream, so the canonical handler shape is
//
//   const chunks = []; req.on('data', c => chunks.push(c));
//   req.on('end', () => Buffer.concat(chunks));
//
// RED on the pre-fix build: __nimbusServeHttp read the body with
// `await request.text()` and `_handleRequest` re-emitted that STRING as the
// 'data' chunk, so Buffer.concat reached `Uint8Array.prototype.subarray.call`
// with a String receiver — "Method %TypedArray%.prototype.subarray called on
// incompatible receiver" — for every POST, at any size. The UTF-8 decode also
// destroyed binary bodies, and IncomingMessage was a bare EventEmitter, so
// `for await (const chunk of req)` and `req.pipe()` had nothing to iterate.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

function makeFacet() {
  delete globalThis.__portRegistry;
  const supervisor = { registerPort: () => {}, unregisterPort: () => {} };
  const factory = new Function(
    '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest', '__supervisor',
    'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + generateShimsCode() +
      '\n;return { http: builtins.http, Buffer: __BufferMod, serveHttp: globalThis.__nimbusServeHttp };',
  );
  return factory(
    {}, {}, {}, {}, {}, supervisor,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  );
}

function routedRequest(port, path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('X-Nimbus-Port', String(port));
  return new Request(`http://127.0.0.1:${port}${path}`, { ...init, headers });
}

const enc = new TextEncoder();

// ── the canonical Buffer.concat handler, at 16 bytes and at 64 KiB ──────────
for (const size of [16, 64 * 1024]) {
  const { http, Buffer, serveHttp } = makeFacet();
  const payload = new Uint8Array(size);
  for (let i = 0; i < size; i++) payload[i] = i & 0xff;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(body);
    });
  });
  server.listen(3000);

  const response = await serveHttp(routedRequest(3000, '/upload', {
    method: 'POST',
    body: payload,
  }));
  assert.equal(response.status, 200, `POST of ${size} bytes is served`);
  const echoed = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(
    [...echoed],
    [...payload],
    `a ${size}-byte POST body survives the round trip byte for byte`,
  );
}

// ── every chunk delivered to 'data' is a Buffer, never a string ─────────────
{
  const { http, Buffer, serveHttp } = makeFacet();
  const seen = [];
  const server = http.createServer((req, res) => {
    req.on('data', (chunk) => {
      seen.push({ isBuffer: Buffer.isBuffer(chunk), typedArray: chunk instanceof Uint8Array });
    });
    req.on('end', () => res.end('ok'));
  });
  server.listen(3001);
  const response = await serveHttp(routedRequest(3001, '/', { method: 'POST', body: 'hello' }));
  await response.text();
  assert.deepEqual(
    seen,
    [{ isBuffer: true, typedArray: true }],
    "'data' chunks are Buffers, the receiver every Buffer method brand-checks",
  );
}

// ── a JSON POST, the shape most real servers actually take ─────────────────
{
  const { http, Buffer, serveHttp } = makeFacet();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: parsed, method: req.method, url: req.url }));
    });
  });
  server.listen(3002);
  const response = await serveHttp(routedRequest(3002, '/api?q=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'nimbus', n: 7 }),
  }));
  assert.deepEqual(await response.json(), {
    echo: { name: 'nimbus', n: 7 },
    method: 'POST',
    url: '/api?q=1',
  });
}

// ── binary bodies are bytes, not a UTF-8 round trip ────────────────────────
{
  const { http, Buffer, serveHttp } = makeFacet();
  // 0x80-0xff are invalid standalone UTF-8; a text() decode replaces them
  // with U+FFFD and the payload is silently corrupted.
  const payload = new Uint8Array([0x00, 0x80, 0xfe, 0xff, 0xc3, 0x28, 0x7f]);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res.end(Buffer.concat(chunks)));
  });
  server.listen(3003);
  const response = await serveHttp(routedRequest(3003, '/bin', { method: 'POST', body: payload }));
  assert.deepEqual(
    [...new Uint8Array(await response.arrayBuffer())],
    [...payload],
    'a binary POST body is not mangled by a UTF-8 decode',
  );
}

// ── IncomingMessage is a Readable: async iteration and pipe both work ──────
{
  const { http, Buffer, serveHttp } = makeFacet();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.end(Buffer.concat(chunks).toString('utf8').toUpperCase());
  });
  server.listen(3004);
  const response = await serveHttp(routedRequest(3004, '/', { method: 'POST', body: 'stream me' }));
  assert.equal(await response.text(), 'STREAM ME', 'for await (const chunk of req) yields the body');
}

// ── a handler that attaches its consumer AFTER an await still gets the body ─
// Node buffers a request body until something reads it. Emitting it into the
// void the instant the handler returns is the same silent-loss failure the
// parked-request queue already fixed one layer up.
{
  const { http, Buffer, serveHttp } = makeFacet();
  const server = http.createServer(async (req, res) => {
    await Promise.resolve();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res.end(Buffer.concat(chunks)));
  });
  server.listen(3005);
  const response = await serveHttp(routedRequest(3005, '/', { method: 'POST', body: 'late reader' }));
  assert.equal(await response.text(), 'late reader', 'a body is held until a consumer attaches');
}

// ── an 'end'-only listener still fires when nothing reads the body ─────────
// The contract the pre-fix unconditional `req.emit("end")` provided; a
// demand-driven stream must not quietly stop honouring it.
{
  const { http, serveHttp } = makeFacet();
  const server = http.createServer((req, res) => {
    req.on('end', () => res.end('ended'));
  });
  server.listen(3006);
  assert.equal(
    await (await serveHttp(routedRequest(3006, '/', { method: 'GET' }))).text(),
    'ended',
    "a GET handler listening only for 'end' still completes",
  );
  assert.equal(
    await (await serveHttp(routedRequest(3006, '/', { method: 'POST', body: 'ignored' }))).text(),
    'ended',
    "a POST handler that never reads the body still gets 'end'",
  );
}

// ── request bodies stay isolated between concurrent requests ───────────────
{
  const { http, Buffer, serveHttp } = makeFacet();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res.end(Buffer.concat(chunks)));
  });
  server.listen(3007);
  const bodies = ['alpha', 'beta-beta', 'gamma-gamma-gamma'];
  const responses = await Promise.all(bodies.map((body) =>
    serveHttp(routedRequest(3007, '/', { method: 'POST', body })).then((r) => r.text())));
  assert.deepEqual(responses, bodies, 'concurrent POSTs do not cross bodies');
}

console.log('node-shims-http-request-body: PASS');
