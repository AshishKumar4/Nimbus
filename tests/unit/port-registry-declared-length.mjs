#!/usr/bin/env bun

/**
 * A port forward keeps the target's Content-Length.
 *
 * The runtime sends a Response body built from any stream chunked, and drops
 * the Content-Length header, unless the stream is a FixedLengthStream, whose
 * length becomes the header on the wire. A guest static server's 200 and 206
 * both declare one, and a browser range reader or download progress bar reads
 * it, so the hop relays a declared length through a FixedLengthStream of that
 * length. Measured live before this: a 206 of 64 bytes and a 210 MiB 200 both
 * reached the client with no Content-Length.
 *
 * The host shim (lib/workerd-fixed-length-stream.mjs) holds the stream to the
 * documented contract and leaves the declared length on the readable, which
 * is what the runtime would send.
 */

import './lib/workerd-fixed-length-stream.mjs';
import './lib/web-compression-streams.mjs';
import assert from 'node:assert/strict';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';

async function routeThrough(handler, method = 'GET') {
  const registry = new PortRegistry();
  registry.bindFacetStub(7, { handleHttpRequest: handler });
  registry.register(3000, 7);
  const response = await registry.routeRequest(
    3000,
    new Request('https://nimbus-os.dev/s/quiet-otter-1/port/3000/big.bin', { method }),
    '/big.bin',
  );
  assert.ok(response, 'the registry routed the request');
  return response;
}

const BYTES = Uint8Array.from({ length: 65_536 + 17 }, (_, i) => (i * 31 + 7) % 256);

// A 200 and a 206 that declare their length go out with it, byte-exact.
for (const [status, body, extra] of [
  [200, BYTES, {}],
  [206, BYTES.subarray(100, 164), { 'Content-Range': `bytes 100-163/${BYTES.byteLength}` }],
]) {
  const response = await routeThrough(async () => new Response(body, {
    status,
    headers: { 'Content-Length': String(body.byteLength), 'Accept-Ranges': 'bytes', ...extra },
  }));
  assert.equal(response.status, status);
  assert.equal(response.body.expectedLength, body.byteLength, `${status}: the declared length reaches the wire`);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body, `${status}: body byte-exact`);
}

// A streamed body keeps its length too: this is the shape a Node server's
// response takes, chunk by chunk.
{
  const response = await routeThrough(async () => new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < BYTES.byteLength; offset += 4096) controller.enqueue(BYTES.slice(offset, offset + 4096));
      controller.close();
    },
  }), { headers: { 'Content-Length': String(BYTES.byteLength) } }));
  assert.equal(response.body.expectedLength, BYTES.byteLength);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), BYTES);
}

// A target that sends a different number of bytes than it declared fails the
// body, as HTTP framing would: fewer would hand the client a short file as
// whole, more would run past the length the client was promised.
{
  const short = await routeThrough(async () => new Response(BYTES.subarray(0, 10), {
    headers: { 'Content-Length': '20' },
  }));
  await assert.rejects(short.arrayBuffer(), /10 of the 20 bytes/);
  const long = await routeThrough(async () => new Response(BYTES.subarray(0, 30), {
    headers: { 'Content-Length': '20' },
  }));
  await assert.rejects(long.arrayBuffer(), /more than the 20 bytes/);
}

// No length, or no single length, relays chunked as before.
for (const declared of [null, '5, 5', '-1', '1e3', '']) {
  const response = await routeThrough(async () => new Response(BYTES.subarray(0, 5), {
    headers: declared === null ? {} : { 'Content-Length': declared },
  }));
  assert.equal(response.body.expectedLength, undefined, `Content-Length ${JSON.stringify(declared)} is not a length`);
  assert.equal((await response.arrayBuffer()).byteLength, 5);
}

// A HEAD answer's length describes the GET; its (empty) body is not held to it.
{
  const response = await routeThrough(async () => new Response('', {
    headers: { 'Content-Length': String(BYTES.byteLength) },
  }), 'HEAD');
  assert.equal(response.body?.expectedLength, undefined, 'a HEAD body is not held to the length');
  assert.equal((await response.arrayBuffer()).byteLength, 0);
}

// A decoded body has a different length; the relay drops the stale one.
{
  const encoded = new Uint8Array(await new Response(
    new Response(BYTES).body.pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer());
  const response = await routeThrough(async () => new Response(encoded, {
    headers: { 'Content-Encoding': 'gzip', 'Content-Length': String(encoded.byteLength) },
  }));
  assert.equal(response.headers.get('content-length'), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), BYTES);
}

console.log('port-registry-declared-length: ok');
