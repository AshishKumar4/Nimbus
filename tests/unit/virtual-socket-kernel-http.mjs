#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { VIRTUAL_SOCKET_KERNEL_SRC } from '../../packages/worker/src/runtime/virtual-socket-kernel.ts';

const oldKernel = globalThis.__nimbusVirtualSockets;
const oldEnsureListener = globalThis.__nimbusVirtualSocketEnsureListener;
const oldRequestQueued = globalThis.__nimbusVirtualSocketRequestQueued;
const oldDidListen = globalThis.__nimbusVirtualSocketDidListen;
const oldLastError = globalThis.__nimbusVirtualSocketLastError;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 1_000)),
  ]);
}

async function requestThroughKernel(kernel, port, request, responseBytes) {
  const responsePromise = withTimeout(kernel.handleHttpRequest(port, request), request.method);
  const accepted = await withTimeout(kernel.accept(port), `${request.method} accept`);
  kernel.send(accepted.id, responseBytes);
  return await responsePromise;
}

try {
  delete globalThis.__nimbusVirtualSockets;
  delete globalThis.__nimbusVirtualSocketEnsureListener;
  delete globalThis.__nimbusVirtualSocketRequestQueued;
  delete globalThis.__nimbusVirtualSocketDidListen;
  delete globalThis.__nimbusVirtualSocketLastError;
  globalThis.eval(VIRTUAL_SOCKET_KERNEL_SRC);

  const kernel = globalThis.__nimbusVirtualSockets;
  const port = kernel.listen(4567);

  {
    const response = await requestThroughKernel(
      kernel,
      port,
      new Request('https://nimbus.local/head', { method: 'HEAD' }),
      'HTTP/1.1 200 OK\r\nContent-Length: 123\r\n\r\n',
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), '123');
    assert.equal(await response.text(), '');
  }

  {
    const response = await requestThroughKernel(
      kernel,
      port,
      new Request('https://nimbus.local/no-content'),
      'HTTP/1.1 204 No Content\r\nContent-Length: 9\r\n\r\n',
    );
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  }
} finally {
  if (oldKernel === undefined) delete globalThis.__nimbusVirtualSockets;
  else globalThis.__nimbusVirtualSockets = oldKernel;
  if (oldEnsureListener === undefined) delete globalThis.__nimbusVirtualSocketEnsureListener;
  else globalThis.__nimbusVirtualSocketEnsureListener = oldEnsureListener;
  if (oldRequestQueued === undefined) delete globalThis.__nimbusVirtualSocketRequestQueued;
  else globalThis.__nimbusVirtualSocketRequestQueued = oldRequestQueued;
  if (oldDidListen === undefined) delete globalThis.__nimbusVirtualSocketDidListen;
  else globalThis.__nimbusVirtualSocketDidListen = oldDidListen;
  if (oldLastError === undefined) delete globalThis.__nimbusVirtualSocketLastError;
  else globalThis.__nimbusVirtualSocketLastError = oldLastError;
}

console.log('virtual-socket-kernel-http: ok');
