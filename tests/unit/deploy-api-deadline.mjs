import assert from 'node:assert/strict';
import { cfApi } from '../behavioral/_deploy-target.mjs';

const realFetch = globalThis.fetch;
let requestStarted;
let releaseHeaders;
let releaseBody;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  assert.equal(request.headers.get('Authorization'), 'Bearer fixture-token');
  if (new URL(request.url).pathname.endsWith('/headers')) {
    requestStarted();
    return new Promise((resolve) => { releaseHeaders = () => resolve(Response.json({ success: true })); });
  }
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"success":'));
    releaseBody = () => { try { controller.close(); } catch {} };
  } }), { headers: { 'Content-Type': 'application/json' } });
} });
globalThis.fetch = (url, options) => realFetch(new URL(new URL(url).pathname, server.url), options);
try {
  const options = { account: 'fixture-account', token: 'fixture-token' };
  const headersStarted = new Promise((resolve) => { requestStarted = resolve; });
  const headersSignal = AbortSignal.timeout(1000);
  const pendingHeaders = cfApi('/headers', { ...options, signal: headersSignal });
  await headersStarted;
  await assert.rejects(pendingHeaders, (error) => error === headersSignal.reason || error.name === 'TimeoutError');
  releaseHeaders();

  const bodySignal = AbortSignal.timeout(1000);
  await assert.rejects(cfApi('/body', { ...options, signal: bodySignal }),
    (error) => error === bodySignal.reason || error.name === 'TimeoutError');
  assert.equal(bodySignal.aborted, true, 'deadline cancellation is not swallowed by JSON parsing');
} finally {
  releaseHeaders?.();
  releaseBody?.();
  globalThis.fetch = realFetch;
  await server.stop(true);
}
console.log('deploy-api-deadline: ok');
