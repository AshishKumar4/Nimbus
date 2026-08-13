#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { VirtualSocketKernel } from '../../packages/core/src/runtime/virtual-socket-kernel.ts';
import { VIRTUAL_SOCKET_KERNEL_SRC } from '../../packages/core/src/runtime/virtual-socket-kernel.generated.ts';

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 1_000)),
  ]);
}

async function requestThroughKernel(kernel, port, request, writes, { closeAfterWrites = false } = {}) {
  const responsePromise = withTimeout(kernel.handleHttpRequest(port, request), request.method);
  const accepted = await withTimeout(kernel.accept(port), `${request.method} accept`);
  for (const bytes of writes) kernel.send(accepted.id, bytes);
  if (closeAfterWrites) kernel.close(accepted.id);
  return { response: await responsePromise, accepted };
}

function drainRequestBytes(kernel, connectionId) {
  const chunks = [];
  for (;;) {
    const chunk = kernel.recv(connectionId, 65536);
    if (chunk.length === 0) break;
    chunks.push(...chunk);
  }
  return new TextDecoder().decode(Uint8Array.from(chunks));
}

// Socket lifecycle: listen, didListen hook, accept, read, write, close.
{
  const listened = [];
  const host = { __nimbusVirtualSocketDidListen: (port) => listened.push(port) };
  const kernel = new VirtualSocketKernel(host);

  assert.equal(kernel.listen(4567), 4567);
  assert.equal(kernel.listen(4567), 4567, 'duplicate listen returns the same port');
  assert.deepEqual(listened, [4567], 'didListen fires once per port');
  const ephemeral = kernel.listen(0);
  assert.ok(ephemeral >= 49152 && ephemeral < 65535, `ephemeral port allocated: ${ephemeral}`);
  assert.equal(kernel.firstListeningPort(), 4567);
  assert.equal(kernel.pending(4567), 0);
  assert.equal(kernel.acceptNow(4567), null);
  assert.throws(() => kernel.acceptNow(9), /port is not listening: 9/);
  assert.throws(() => kernel.listen(65536), /invalid port: 65536/);

  const responsePromise = withTimeout(
    kernel.handleHttpRequest(4567, new Request('https://nimbus.local/hello?x=1')),
    'GET lifecycle',
  );
  const accepted = await withTimeout(kernel.accept(4567), 'lifecycle accept');
  assert.equal(typeof accepted.id, 'number');
  assert.equal(accepted.host, '127.0.0.1');

  const requestText = drainRequestBytes(kernel, accepted.id);
  assert.ok(requestText.startsWith('GET /hello?x=1 HTTP/1.1\r\n'), `request line: ${requestText.split('\r\n')[0]}`);
  assert.match(requestText, /\r\nhost: nimbus\.local\r\n/i);
  assert.ok(requestText.endsWith('\r\n\r\n'), 'request ends with the header terminator');
  assert.deepEqual(kernel.recv(accepted.id, 16), [], 'recv after EOF returns no bytes');

  const payload = 'hello world';
  const head = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${payload.length}\r\n\r\n`;
  assert.equal(kernel.send(accepted.id, head), head.length, 'send reports bytes written');
  kernel.send(accepted.id, new TextEncoder().encode(payload.slice(0, 5)));
  kernel.send(accepted.id, Array.from(new TextEncoder().encode(payload.slice(5))));
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.equal(await response.text(), payload);
  assert.throws(() => kernel.send(accepted.id, 'late'), /connection is closed/);
  assert.deepEqual(kernel.recv(accepted.id, 16), [], 'recv on a torn-down connection returns no bytes');
}

// POST request body is serialized into the accepted byte stream.
{
  const kernel = new VirtualSocketKernel({});
  const port = kernel.listen(8080);
  const responsePromise = withTimeout(
    kernel.handleHttpRequest(port, new Request('https://nimbus.local/submit', { method: 'POST', body: 'ping' })),
    'POST',
  );
  const accepted = await withTimeout(kernel.accept(port), 'POST accept');
  const requestText = drainRequestBytes(kernel, accepted.id);
  assert.ok(requestText.startsWith('POST /submit HTTP/1.1\r\n'));
  assert.match(requestText, /\r\ncontent-length: 4\r\n/i);
  assert.ok(requestText.endsWith('\r\n\r\nping'), 'body follows the header terminator');
  kernel.send(accepted.id, 'HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n');
  assert.equal((await responsePromise).status, 201);
}

// HEAD with Content-Length completes without waiting for a body (regression).
{
  const kernel = new VirtualSocketKernel({});
  const port = kernel.listen(4567);
  const { response } = await requestThroughKernel(
    kernel,
    port,
    new Request('https://nimbus.local/head', { method: 'HEAD' }),
    ['HTTP/1.1 200 OK\r\nContent-Length: 123\r\n\r\n'],
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '123');
  assert.equal(await response.text(), '');
}

// 204/205/304 never carry a body even when Content-Length is present (regression).
for (const [status, statusText] of [[204, 'No Content'], [205, 'Reset Content'], [304, 'Not Modified']]) {
  const kernel = new VirtualSocketKernel({});
  const port = kernel.listen(4567);
  const { response } = await requestThroughKernel(
    kernel,
    port,
    new Request('https://nimbus.local/no-content'),
    [`HTTP/1.1 ${status} ${statusText}\r\nContent-Length: 9\r\n\r\n`],
  );
  assert.equal(response.status, status);
  assert.equal(await response.text(), '');
}

// Chunked responses reassemble across arbitrary write boundaries.
{
  const kernel = new VirtualSocketKernel({});
  const port = kernel.listen(4567);
  const { response } = await requestThroughKernel(
    kernel,
    port,
    new Request('https://nimbus.local/chunked'),
    [
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nX-Server: webrick\r\n\r\n5\r\nhel',
      'lo\r\n6;ext=1\r\n wor',
      'ld\r\n0\r\n\r\n',
    ],
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('transfer-encoding'), null, 'chunked framing is consumed by the kernel');
  assert.equal(response.headers.get('x-server'), 'webrick');
  assert.equal(await response.text(), 'hello world');
}

// Until-close framing: no Content-Length, body completes when the server closes.
{
  const kernel = new VirtualSocketKernel({});
  const port = kernel.listen(4567);
  const { response } = await requestThroughKernel(
    kernel,
    port,
    new Request('https://nimbus.local/stream'),
    ['HTTP/1.1 200 OK\r\n\r\nstreamed ', 'bytes'],
    { closeAfterWrites: true },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'streamed bytes');
}

// Connection abort: server closes before response headers.
{
  const kernel = new VirtualSocketKernel({});
  const port = kernel.listen(4567);
  const { response } = await requestThroughKernel(
    kernel,
    port,
    new Request('https://nimbus.local/dead'),
    ['HTTP/1.1 2'],
    { closeAfterWrites: true },
  );
  assert.equal(response.status, 502);
  assert.match(await response.text(), /connection closed before response headers/);
}

// Connection abort: server closes mid Content-Length body.
{
  const kernel = new VirtualSocketKernel({});
  const port = kernel.listen(4567);
  const { response } = await requestThroughKernel(
    kernel,
    port,
    new Request('https://nimbus.local/truncated'),
    ['HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhal'],
    { closeAfterWrites: true },
  );
  assert.equal(response.status, 502);
  assert.match(await response.text(), /connection closed before the response completed/);
}

// Client abort propagates: pending request settles and the connection tears down.
{
  const kernel = new VirtualSocketKernel({});
  const port = kernel.listen(4567);
  const controller = new AbortController();
  const responsePromise = withTimeout(
    kernel.handleHttpRequest(port, new Request('https://nimbus.local/slow', { signal: controller.signal })),
    'aborted GET',
  );
  const accepted = await withTimeout(kernel.accept(port), 'abort accept');
  controller.abort();
  const response = await responsePromise;
  assert.equal(response.status, 499);
  assert.match(await response.text(), /client aborted the request/);
  assert.throws(() => kernel.send(accepted.id, 'too late'), /connection is closed/);
}

// Bounded buffering: response writes beyond the limit fail loudly.
{
  const kernel = new VirtualSocketKernel({}, { maxResponseBufferBytes: 64 });
  const port = kernel.listen(4567);
  const responsePromise = withTimeout(
    kernel.handleHttpRequest(port, new Request('https://nimbus.local/big')),
    'overflow GET',
  );
  const accepted = await withTimeout(kernel.accept(port), 'overflow accept');
  kernel.send(accepted.id, 'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n');
  assert.throws(() => kernel.send(accepted.id, 'x'.repeat(32)), /response buffer exceeds 64 bytes/);
  kernel.close(accepted.id);
  assert.equal((await responsePromise).status, 502);
}

// Bounded buffering: oversized request bodies are rejected before queueing.
{
  const kernel = new VirtualSocketKernel({}, { maxRequestBodyBytes: 4 });
  const port = kernel.listen(4567);
  const response = await withTimeout(
    kernel.handleHttpRequest(port, new Request('https://nimbus.local/upload', { method: 'POST', body: 'hello' })),
    'oversized POST',
  );
  assert.equal(response.status, 413);
  assert.equal(kernel.pending(port), 0, 'rejected request never reaches the listener queue');
}

// closeListener aborts queued connections and pending accepts with clear errors.
{
  const kernel = new VirtualSocketKernel({});
  const port = kernel.listen(4567);
  const queuedPromise = withTimeout(
    kernel.handleHttpRequest(port, new Request('https://nimbus.local/queued')),
    'queued GET',
  );
  await Promise.resolve();
  assert.equal(kernel.pending(port), 1);
  kernel.closeListener(port);
  const response = await queuedPromise;
  assert.equal(response.status, 502);
  assert.match(await response.text(), /listener closed on port 4567/);
  assert.throws(() => kernel.acceptNow(port), /port is not listening: 4567/);
}

// Cooperative accept hooks: ensureListener creates the listener on demand,
// requestQueued=false rejects with the runtime's lastError detail.
{
  const host = {
    __nimbusVirtualSocketEnsureListener: (port) => {
      kernel.listen(port);
      pumpedPorts.push(`ensure:${port}`);
    },
    __nimbusVirtualSocketRequestQueued: async (port) => {
      pumpedPorts.push(`pump:${port}`);
      const accepted = kernel.acceptNow(port);
      assert.ok(accepted, 'pump sees the queued connection');
      drainRequestBytes(kernel, accepted.id);
      kernel.send(accepted.id, 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
      kernel.close(accepted.id);
      return true;
    },
  };
  const pumpedPorts = [];
  const kernel = new VirtualSocketKernel(host);
  const response = await withTimeout(
    kernel.handleHttpRequest(3098, new Request('https://nimbus.local/')),
    'cooperative GET',
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(pumpedPorts, ['ensure:3098', 'pump:3098']);

  host.__nimbusVirtualSocketRequestQueued = () => false;
  host.__nimbusVirtualSocketLastError = 'handler exploded';
  const rejected = await withTimeout(
    kernel.handleHttpRequest(3098, new Request('https://nimbus.local/')),
    'rejected GET',
  );
  assert.equal(rejected.status, 502);
  assert.equal(
    await rejected.text(),
    'Nimbus virtual socket: runtime handler did not accept the request: handler exploded',
  );

  const unlistened = await withTimeout(
    new VirtualSocketKernel({}).handleHttpRequest(9999, new Request('https://nimbus.local/')),
    'unlistened GET',
  );
  assert.equal(unlistened.status, 502);
  assert.match(await unlistened.text(), /no listener on port 9999/);
}

// Readiness: waitReadable resolves on queued connections, [] on timeout;
// waitForListen resolves the first listening port.
{
  const kernel = new VirtualSocketKernel({});
  const listenPromise = withTimeout(kernel.waitForListen(1_000), 'waitForListen');
  const port = kernel.listen(8125);
  assert.equal(await listenPromise, 8125);
  assert.equal(await kernel.waitForListen(1_000), 8125, 'existing listener resolves immediately');

  assert.deepEqual(await withTimeout(kernel.waitReadable([port], 0.05), 'waitReadable timeout'), []);

  const readablePromise = withTimeout(kernel.waitReadable([port, 9_999], 2), 'waitReadable');
  const responsePromise = withTimeout(kernel.handleHttpRequest(port, new Request('https://nimbus.local/')), 'readable GET');
  assert.deepEqual(await readablePromise, [port]);
  const accepted = kernel.acceptNow(port);
  assert.ok(accepted);
  kernel.send(accepted.id, 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
  assert.equal((await responsePromise).status, 200);
}

// Injection contract: the generated bundle is self-contained, installs the
// kernel on globalThis, and serves the same HTTP bridge.
{
  assert.ok(!/\bimport\b|\bexport\b|\brequire\(/.test(VIRTUAL_SOCKET_KERNEL_SRC.replace(/\/\/[^\n]*/g, '')),
    'injected source must not import or export anything');
  const previous = globalThis.__nimbusVirtualSockets;
  delete globalThis.__nimbusVirtualSockets;
  try {
    globalThis.eval(VIRTUAL_SOCKET_KERNEL_SRC);
    const kernel = globalThis.__nimbusVirtualSockets;
    assert.ok(kernel, 'injected source installs __nimbusVirtualSockets');
    globalThis.eval(VIRTUAL_SOCKET_KERNEL_SRC);
    assert.equal(globalThis.__nimbusVirtualSockets, kernel, 'reinjection reuses the installed kernel');

    const port = kernel.listen(4567);
    assert.ok(kernel.listeners instanceof Map && kernel.listeners.has(port), 'listeners map stays public for runner glue');
    const { response } = await requestThroughKernel(
      kernel,
      port,
      new Request('https://nimbus.local/head', { method: 'HEAD' }),
      ['HTTP/1.1 200 OK\r\nContent-Length: 123\r\n\r\n'],
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), '123');
    assert.equal(await response.text(), '');
  } finally {
    if (previous === undefined) delete globalThis.__nimbusVirtualSockets;
    else globalThis.__nimbusVirtualSockets = previous;
  }
}

console.log('virtual-socket-kernel: ok');
