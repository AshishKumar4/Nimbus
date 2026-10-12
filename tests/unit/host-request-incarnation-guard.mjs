import assert from 'node:assert/strict';
import './facet-host-harness.mjs';
import { observeResidentConfig, HOST_WATCH_HEADER, HOST_INCARNATION_HEADER } from '../../packages/fabric/src/host-activity.ts';
import { importModuleSet } from './lib/module-map-bundle.mjs';

const REQUEST_GUARD = 'x-nimbus-host-request';
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
function request(nonce, token = capability, upgrade = false) {
  return new Request('https://leaf.invalid/user/path?kept=yes', {
    method: upgrade ? 'GET' : 'POST', body: upgrade ? undefined : 'request payload',
    headers: { [REQUEST_GUARD]: token, [HOST_INCARNATION_HEADER]: nonce,
      'x-application-header': 'kept', ...(upgrade ? { Upgrade: 'websocket' } : {}) },
  });
}

for (const entry of ['handleHttpRequest', 'fetch']) {
  const ctx = { starts: 0, handlers: 0, seen: [] };
  const old = new NimbusProcess(ctx, {}), pinned = await incarnation(old);
  // A new object models the platform replacing the leaf instance. Constructor
  // execution is unavoidable; guest start and request dispatch are the guard.
  const replacement = new NimbusProcess(ctx, {});
  assert.notEqual(await incarnation(replacement), pinned);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await replacement[entry](request(pinned));
    await response.body?.cancel();
    assert.equal(ctx.starts, 0, 'stale data never starts the replacement guest');
    assert.equal(ctx.handlers, 0, 'stale data is refused before either guest entrypoint');
    assert.equal(response.status, 410, 'the old pinned nonce cannot be refreshed by a data reply');
    assert.equal(response.headers.get(REQUEST_GUARD), capability, 'only an authenticated guard refusal carries the per-open brand');
  }
}
for (const entry of ['handleHttpRequest', 'fetch']) {
  const ctx = { starts: 0, handlers: 0, seen: [] }, process = new NimbusProcess(ctx, {});
  const nonce = await incarnation(process);
  const refused = await process[entry](request(nonce, 'wrong-capability'));
  await refused.body?.cancel();
  assert.equal(ctx.handlers, 0, 'an incarnation nonce alone cannot authorize guest data');
  assert.equal(refused.status, 404);
  const response = await process[entry](request(nonce));
  assert.equal(await response.text(), 'guest answer');
  assert.equal(response.headers.get('x-guest-answer'), 'kept');
  assert.deepEqual(ctx.seen, [{ entry: entry === 'fetch' ? 'fetch' : 'http', method: 'POST',
    headers: [['content-type', 'text/plain;charset=UTF-8'], ['x-application-header', 'kept']], body: 'request payload' }],
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
