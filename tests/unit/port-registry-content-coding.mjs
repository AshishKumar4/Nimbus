#!/usr/bin/env bun

/**
 * A port forward hands the browser bytes and headers that agree.
 *
 * A `Response` a facet builds always holds an identity body: the runtime
 * treats the bytes it is constructed from as unencoded, so it drops a
 * `Content-Encoding` the client did not ask for and compresses again when the
 * client did. A guest server's `Content-Encoding` therefore describes nothing,
 * and a browser that trusts it renders compressed bytes as text.
 *
 * So the hop speaks identity: it asks the target for identity, and decodes the
 * target that compresses anyway. Bodies are compared by hash, not by eye.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function compress(bytes, format) {
  const stream = new Response(bytes).body.pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function routeThrough(handler, { headers = {} } = {}) {
  const registry = new PortRegistry();
  registry.bindFacetStub(7, { handleHttpRequest: handler });
  registry.register(3000, 7);
  const response = await registry.routeRequest(
    3000,
    new Request('https://nimbus-os.dev/s/quiet-otter-1/port/3000/', { headers }),
    '/',
  );
  assert.ok(response, 'the registry routed the request');
  return response;
}

const HTML = new TextEncoder().encode(
  `<!doctype html><html><head><title>Probe</title></head><body>${'A'.repeat(2000)}</body></html>`,
);
const BINARY = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7 + 13) % 256);

// The target is told the one coding this hop can carry, whatever the browser asked for.
{
  const response = await routeThrough(
    async (request) => Response.json({ accept: request.headers.get('accept-encoding') }),
    { headers: { 'Accept-Encoding': 'gzip, deflate, br, zstd' } },
  );
  assert.equal((await response.json()).accept, 'identity');
}

// A server that compresses anyway: the body arrives decoded, byte-exact, and
// no header still claims it is compressed.
for (const [coding, format] of [['gzip', 'gzip'], ['x-gzip', 'gzip'], ['deflate', 'deflate']]) {
  const encoded = await compress(HTML, format);
  assert.notEqual(sha(encoded), sha(HTML), `${coding}: the fixture is really encoded`);

  const response = await routeThrough(async () => new Response(encoded, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Encoding': coding,
      'Content-Length': String(encoded.byteLength),
      'Cache-Control': 'no-store',
    },
  }));

  assert.equal(response.status, 200, `${coding}: status`);
  assert.equal(response.headers.get('content-encoding'), null, `${coding}: no stale coding`);
  assert.equal(response.headers.get('content-length'), null, `${coding}: no stale length`);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', `${coding}: type kept`);
  assert.equal(response.headers.get('cache-control'), 'no-store', `${coding}: other headers kept`);
  const body = new Uint8Array(await response.arrayBuffer());
  assert.equal(sha(body), sha(HTML), `${coding}: body is the original bytes`);
}

// A binary body carries no coding, so nothing touches it.
{
  const response = await routeThrough(async () => new Response(BINARY, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(BINARY.byteLength),
    },
  }));
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-length'), String(BINARY.byteLength), 'length untouched');
  const body = new Uint8Array(await response.arrayBuffer());
  assert.equal(sha(body), sha(BINARY), 'binary bodies pass byte-exact');
}

// A compressed binary body is decoded to the same bytes.
{
  const encoded = await compress(BINARY, 'gzip');
  const response = await routeThrough(async () => new Response(encoded, {
    headers: { 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip' },
  }));
  const body = new Uint8Array(await response.arrayBuffer());
  assert.equal(sha(body), sha(BINARY), 'a compressed binary body decodes byte-exact');
  assert.equal(response.headers.get('content-type'), 'application/wasm');
}

// `identity` is already what the hop carries, so the response is untouched.
{
  const response = await routeThrough(async () => new Response(HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'identity' },
  }));
  assert.equal(response.headers.get('content-encoding'), 'identity', 'identity is left alone');
  assert.equal(sha(new Uint8Array(await response.arrayBuffer())), sha(HTML));
}

// A coding with no decoder fails loudly rather than serving mojibake.
{
  const response = await routeThrough(async () => new Response(HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'br' },
  }));
  assert.equal(response.status, 502, 'an undecodable coding is a 502');
  const failure = await response.json();
  assert.match(failure.error, /Content-Encoding "br"/, 'the failure names the coding');
  assert.equal(failure.port, 3000);
}

// A bodyless response has nothing to decode, coding header or not.
{
  const response = await routeThrough(async () => new Response(null, {
    status: 304,
    headers: { 'Content-Encoding': 'gzip', ETag: '"abc"' },
  }));
  assert.equal(response.status, 304);
  assert.equal(response.headers.get('etag'), '"abc"');
}

console.log('port-registry-content-coding: ok');
