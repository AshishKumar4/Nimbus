#!/usr/bin/env bun
// Behavior test: the generated Node http shim parks requests that arrive
// before any "request" listener is attached and flushes them when the first
// handler attaches.
//
// Root cause this guards against (live-diagnosed 2026-07-16): effect-platform's
// NodeHttpServer (opencode serve) binds via listen() FIRST and attaches its
// "request" handler only after the HTTP-app layer is built. On the pre-fix
// shim, a request routed into that window was emitted into zero listeners and
// silently lost — its ServerResponse never got headers, the dispatcher's 30s
// header timeout fired, and the dual-mode /doc readiness gate starved on the
// hung poll (bare `opencode` never launched its TUI).

import assert from 'node:assert/strict';
import { routedRequest, shimHttpFacet } from './lib/node-http-platform.mjs';

const dec = new TextDecoder();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── requests before on("request") are parked, then served on attach ──────────
{
  const { http, serveHttp } = shimHttpFacet();
  const server = http.createServer(); // effect-platform: no handler yet
  server.listen(4096);

  // Two requests land in the listen→handler window.
  const resPromise1 = serveHttp(routedRequest(4096, '/doc'));
  const resPromise2 = serveHttp(routedRequest(4096, '/event'));
  await sleep(30);

  const served = [];
  server.on('request', (req, res) => {
    served.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: req.url }));
  });

  const [res1, res2] = await Promise.all([resPromise1, resPromise2]);
  assert.equal(res1.status, 200, 'parked request answered once the handler attached');
  assert.equal(res2.status, 200, 'second parked request answered too');
  assert.deepEqual(JSON.parse(await res1.text()), { url: '/doc' });
  assert.deepEqual(JSON.parse(await res2.text()), { url: '/event' });
  assert.deepEqual(served, ['/doc', '/event'], 'parked requests flushed in arrival order');

  // A request AFTER attach dispatches directly (nothing stays parked).
  const res3 = await serveHttp(routedRequest(4096, '/after'));
  assert.equal(res3.status, 200);
  assert.deepEqual(JSON.parse(await res3.text()), { url: '/after' });
}

// ── request bodies survive parking ────────────────────────────────────────────
{
  const { http, serveHttp } = shimHttpFacet();
  const server = http.createServer();
  server.listen(4097);

  const resPromise = serveHttp(routedRequest(4097, '/echo', { method: 'POST', body: 'hello-parked' }));
  await sleep(30);

  server.on('request', (req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { res.writeHead(200); res.end('echo:' + body); });
  });

  const res = await resPromise;
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'echo:hello-parked', 'parked POST body replayed to the handler');
}

// ── createServer(handler) keeps the direct synchronous dispatch path ─────────
{
  const { http, serveHttp } = shimHttpFacet();
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('direct'); });
  server.listen(4098);
  const res = await serveHttp(routedRequest(4098, '/'));
  assert.equal(res.status, 200);
  assert.equal(dec.decode(await res.bytes()), 'direct');
}

console.log('node-shims-http-parked-requests: ok');
