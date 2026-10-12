import assert from 'node:assert/strict';
import './facet-host-harness.mjs';
import { observeResidentConfig, HOST_WATCH_HEADER, HOST_INCARNATION_HEADER, HOST_REQUEST_HEADER as REQUEST_GUARD } from '../../packages/fabric/src/host-activity.ts';
import { importModuleSet } from './lib/module-map-bundle.mjs';

const capability = 'test-host-request-capability';
const config = observeResidentConfig({
  compatibilityDate: '2026-09-26', mainModule: 'guest.js', modules: {
    'guest.js': `import { DurableObject } from "cloudflare:workers";
export class NimbusProcess extends DurableObject {
  startProcess() { this.ctx.starts++; return 'started'; }
  async handleHttpRequest(request) { return this.answer(request, 'http'); }
  async fetch(request) { return this.answer(request, 'fetch'); }
  async answer(request, entry) {
    this.ctx.handlers++;
    this.ctx.signal = request.signal;
    this.ctx.seen.push({ entry, method: request.method, headers: [...request.headers], body: await request.text() });
    if (request.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept(); return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('guest answer', { headers: { 'x-guest-answer': 'kept' } });
  }
}`,
  },
}, capability);
const { NimbusProcess } = await importModuleSet(config.modules, config.mainModule);

async function incarnation(process) {
  const response = await process.fetch(new Request('https://leaf.invalid/', { headers: { [HOST_WATCH_HEADER]: capability } }));
  const value = response.headers.get(HOST_INCARNATION_HEADER);
  await response.body.cancel();
  assert.ok(value, 'the initial authenticated watch pins the original instance');
  return value;
}
// The host's own entry takes the request's caller (CallerLeft) beside it.
const staying = () => new Promise(() => {});
async function call(process, entry, sent) {
  return entry === 'hostHttpRequest' ? process.hostHttpRequest(sent, staying) : process[entry](sent);
}
function request(nonce, token = capability, upgrade = false) {
  return new Request('https://leaf.invalid/user/path?kept=yes', {
    method: upgrade ? 'GET' : 'POST', body: upgrade ? undefined : 'request payload',
    headers: { [REQUEST_GUARD]: token, [HOST_INCARNATION_HEADER]: nonce,
      'x-application-header': 'kept', ...(upgrade ? { Upgrade: 'websocket' } : {}) },
  });
}

for (const entry of ['hostHttpRequest', 'handleHttpRequest', 'fetch']) {
  const ctx = { starts: 0, handlers: 0, seen: [] };
  const old = new NimbusProcess(ctx, {}), pinned = await incarnation(old);
  // A new object models the platform replacing the leaf instance. Constructor
  // execution is unavoidable; guest start and request dispatch are the guard.
  const replacement = new NimbusProcess(ctx, {});
  assert.notEqual(await incarnation(replacement), pinned);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await call(replacement, entry, request(pinned));
    await response.body?.cancel();
    assert.equal(ctx.starts, 0, 'stale data never starts the replacement guest');
    assert.equal(ctx.handlers, 0, 'stale data is refused before either guest entrypoint');
    assert.equal(response.status, 410, 'the old pinned nonce cannot be refreshed by a data reply');
    assert.equal(response.headers.get(REQUEST_GUARD), capability, 'only an authenticated guard refusal carries the per-open brand');
  }
}
for (const entry of ['hostHttpRequest', 'handleHttpRequest', 'fetch']) {
  const ctx = { starts: 0, handlers: 0, seen: [] }, process = new NimbusProcess(ctx, {});
  const nonce = await incarnation(process);
  const refused = await call(process, entry, request(nonce, 'wrong-capability'));
  await refused.body?.cancel();
  assert.equal(ctx.handlers, 0, 'an incarnation nonce alone cannot authorize guest data');
  assert.equal(refused.status, 404);
  const response = await call(process, entry, request(nonce));
  assert.equal(await response.text(), 'guest answer');
  assert.equal(response.headers.get('x-guest-answer'), 'kept');
  // What the client sent, as this runtime constructs it, without the private transport.
  const sent = new Request('https://leaf.invalid/', { method: 'POST', body: 'request payload', headers: { 'x-application-header': 'kept' } });
  assert.deepEqual(ctx.seen, [{ entry: entry === 'fetch' ? 'fetch' : 'http', method: 'POST', headers: [...sent.headers], body: 'request payload' }],
    'the data guard strips its capability/nonce and preserves ordinary request semantics');
}
{
  const ctx = { starts: 0, handlers: 0, seen: [] }, old = new NimbusProcess(ctx, {});
  const pinned = await incarnation(old), replacement = new NimbusProcess(ctx, {});
  const response = await replacement.fetch(request(pinned, capability, true));
  assert.equal(ctx.handlers, 0, 'the WebSocket entrypoint refuses a replaced actor before upgrade');
  assert.equal(response.status, 410);
  assert.equal(response.webSocket, undefined);
}
{
  const ctx = { starts: 0, handlers: 0, seen: [] }, process = new NimbusProcess(ctx, {});
  const leaving = Promise.withResolvers();
  let dups = 0, disposed = 0;
  const left = Object.assign(() => leaving.promise, { dup: () => { dups++; return Object.assign(() => leaving.promise, { [Symbol.dispose]() { disposed++; } }); } });
  const response = await process.hostHttpRequest(request(await incarnation(process)), left);
  assert.equal(await response.text(), 'guest answer');
  assert.equal(ctx.signal.aborted, false);
  leaving.resolve(true); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.signal.aborted, true, 'the guest sees its caller leave as its request signal');
  assert.deepEqual([dups, disposed], [1, 1], 'the leaf keeps its own copy of the caller stub until the answer, then disposes it');
}
