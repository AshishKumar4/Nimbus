#!/usr/bin/env bun
// Behavior test: the generated Node http shim streams responses. The dispatch
// helper globalThis.__nimbusServeHttp replays a routed request through the
// in-facet server's _handleRequest and returns a host Response whose body is a
// live ReadableStream — bytes flow as the handler writes them, the response is
// returned the moment headers are known (not buffered to "finish"), a handler
// that never sends headers is bounded by a header timeout (not a body-finish
// cap), and a downstream cancel releases the handler. This is what lets an SSE
// / chunked facet server stream live across the port-registry RPC boundary.
//
// RED on the pre-fix build: the old ServerResponse buffered writes into a
// _body array and the dispatch waited up to 5s for "finish" before returning a
// single fully-materialized Response, so nothing arrived before end() and a
// never-ending SSE returned a dead 5s-capped body.

import assert from 'node:assert/strict';
import { generateShimsCode } from './lib/node-http-platform.mjs';

function makeFacet() {
  // Each facet isolate owns a fresh port registry; the shim re-creates it on
  // load. (globalThis is shared across new-Function sandboxes in this process,
  // so drop the prior map to mirror an isolated facet.)
  delete globalThis.__portRegistry;
  const supervisor = { registerPort: () => {}, unregisterPort: () => {} };
  const code = generateShimsCode();
  const factory = new Function(
    '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + code + '\n;return { http: builtins.http, portRegistry: globalThis.__portRegistry, serveHttp: globalThis.__nimbusServeHttp };',
  );
  const sandbox = factory(
    {},
    {},
    {},
    supervisor,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user',
    [],
    {},
    '/home/user/main.mjs',
    '/home/user',
  );
  return sandbox;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function routedRequest(port, path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('X-Nimbus-Port', String(port));
  return new Request(`http://127.0.0.1:${port}${path}`, { ...init, headers });
}

// ── streaming: multiple writes arrive as SEPARATE chunks BEFORE end() ────────
{
  const { http, serveHttp } = makeFacet();
  assert.equal(typeof serveHttp, 'function', 'globalThis.__nimbusServeHttp is installed by the http shim');

  // A gated handler: writes chunk 1, then chunk 2 only when the test releases a
  // gate, then ends only when a second gate is released. Proves chunks stream
  // out incrementally instead of being buffered until end().
  let releaseChunk2, releaseEnd;
  const chunk2Gate = new Promise((r) => { releaseChunk2 = r; });
  const endGate = new Promise((r) => { releaseEnd = r; });

  const server = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: one\n\n');
    await chunk2Gate;
    res.write('data: two\n\n');
    await endGate;
    res.end('data: bye\n\n');
  });
  server.listen(4310);

  const res = await serveHttp(routedRequest(4310, '/sse'));
  assert.equal(res.status, 200, 'headers returned immediately (before the body finishes)');
  assert.equal(res.headers.get('content-type'), 'text/event-stream', 'streaming headers passed through');
  assert.ok(res.body, 'response has a streaming body');

  const reader = res.body.getReader();

  // First chunk must be readable while the handler is still parked before chunk 2.
  const first = await reader.read();
  assert.equal(first.done, false, 'first chunk arrives before end()');
  assert.equal(dec.decode(first.value), 'data: one\n\n', 'first write streamed verbatim');

  // Release chunk 2 and read it — still before end().
  releaseChunk2();
  const second = await reader.read();
  assert.equal(second.done, false, 'second chunk arrives before end()');
  assert.equal(dec.decode(second.value), 'data: two\n\n', 'second write streamed verbatim');

  // Now release end; the final chunk then close.
  releaseEnd();
  const third = await reader.read();
  assert.equal(dec.decode(third.value), 'data: bye\n\n', 'end() payload streamed');
  const fin = await reader.read();
  assert.equal(fin.done, true, 'stream closes after end()');
}

// ── a buffered handler (single end(body)) still works as a one-shot ──────────
{
  const { http, serveHttp } = makeFacet();
  const server = http.createServer((_req, res) => {
    res.statusCode = 201;
    res.setHeader('x-kind', 'buffered');
    res.end('hello world');
  });
  server.listen(4311);
  const res = await serveHttp(routedRequest(4311, '/'));
  assert.equal(res.status, 201, 'statusCode without writeHead is honored');
  assert.equal(res.headers.get('x-kind'), 'buffered');
  assert.equal(await res.text(), 'hello world', 'body is the exact bytes written');
}

// ── binary safety: raw bytes stream through unchanged (no String() corruption)
{
  const { http, serveHttp } = makeFacet();
  const payload = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7f, 0xc3, 0x28]);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(payload);
  });
  server.listen(4312);
  const res = await serveHttp(routedRequest(4312, '/bin'));
  const got = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...got], [...payload], 'binary body is byte-identical (not UTF-8 mangled)');
}

// ── header timeout: a handler that never sends headers is bounded (504) ──────
{
  const { http, serveHttp } = makeFacet();
  globalThis.__nimbusHttpHeaderTimeoutMs = 150; // pin low for the test
  let handlerRes;
  const server = http.createServer((_req, res) => { handlerRes = res; /* never writes headers */ });
  server.listen(4313);
  // Ordered, not timed: a timer due before the pinned timeout has fired when
  // the 504 arrives, and the default (30 s) would lose to the guard.
  let dueEarlier = false;
  setTimeout(() => { dueEarlier = true; }, 50);
  let guard;
  const res = await Promise.race([
    serveHttp(routedRequest(4313, '/hang')),
    new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('the pinned header timeout was not honored')), 20_000); }),
  ]).finally(() => clearTimeout(guard));
  assert.equal(res.status, 504, 'a handler that sends no headers times out with 504');
  assert.equal(await res.text(), 'Nimbus: HTTP handler sent no response headers in time');
  assert.equal(dueEarlier, true, 'the 504 came before its timeout');
  assert.equal(handlerRes.destroyed, true, 'the hung handler response is destroyed on timeout');
  delete globalThis.__nimbusHttpHeaderTimeoutMs;
}

// ── header timeout does NOT truncate a live stream that never "finishes" ─────
{
  const { http, serveHttp } = makeFacet();
  globalThis.__nimbusHttpHeaderTimeoutMs = 150;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: alive\n\n');
    // never ends — an SSE stream
  });
  server.listen(4314);
  const res = await serveHttp(routedRequest(4314, '/event'));
  assert.equal(res.status, 200, 'a never-ending stream returns 200 (headers came in time)');
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.equal(dec.decode(first.value), 'data: alive\n\n', 'SSE frame streams even though the body never finishes');
  // A read that would block indefinitely must NOT be closed by any body cap.
  const race = await Promise.race([
    reader.read().then(() => 'read'),
    new Promise((r) => setTimeout(() => r('still-open'), 400)),
  ]);
  assert.equal(race, 'still-open', 'the stream stays open past the header timeout (no body-finish cap)');
  await reader.cancel();
}

// Downstream cancellation closes the native response.
{
  const { http, serveHttp } = makeFacet();
  let closed = false;
  const server = http.createServer((_req, res) => {
    res.on('close', () => { closed = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: hi\n\n');
  });
  server.listen(4315);
  const res = await serveHttp(routedRequest(4315, '/event'));
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel(); // downstream (client / attach facet) goes away
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, true, 'res emits close when the downstream cancels');
}

// ── no server on the port → honest 502 ───────────────────────────────────────
{
  const { serveHttp } = makeFacet();
  const res = await serveHttp(routedRequest(9999, '/'));
  assert.equal(res.status, 502, 'no listening server yields 502');
}

console.log('ok: node http shim streams responses (chunked/SSE), bounds header timeout, cancels on disconnect');
