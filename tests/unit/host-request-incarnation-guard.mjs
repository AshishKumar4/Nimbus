import assert from 'node:assert/strict';
import './lib/facet-host-harness.mjs';
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
    this.ctx.request = request;
    this.ctx.signal = request.signal;
    // What a guest that forwards its request keeps: a clone and a copy.
    this.ctx.forwarded = [request.clone().signal, new Request(request.clone()).signal];
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
// Both data entrypoints: the host's (its fetch: HTTP to the guest's handler,
// an upgrade to the guest's fetch) and the guest's handler reached directly.
const call = (process, entry, sent) => process[entry](sent);
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
    const response = await call(replacement, entry, request(pinned));
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
  const refused = await call(process, entry, request(nonce, 'wrong-capability'));
  await refused.body?.cancel();
  assert.equal(ctx.handlers, 0, 'an incarnation nonce alone cannot authorize guest data');
  assert.equal(refused.status, 404);
  const response = await call(process, entry, request(nonce));
  assert.equal(await response.text(), 'guest answer');
  assert.equal(response.headers.get('x-guest-answer'), 'kept');
  // What the client sent, as this runtime constructs it, without the private transport.
  const sent = new Request('https://leaf.invalid/', { method: 'POST', body: 'request payload', headers: { 'x-application-header': 'kept' } });
  assert.deepEqual(ctx.seen, [{ entry: 'http', method: 'POST', headers: [...sent.headers], body: 'request payload' }],
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
  // A request its host sends without its admission is one a live watch that
  // found this instance admitted (HostObservation.validated): the guest gets
  // it as sent, no copy, and an upgrade still goes to the guest's fetch.
  const ctx = { starts: 0, handlers: 0, seen: [] }, process = new NimbusProcess(ctx, {});
  await incarnation(process);
  const sent = new Request('https://leaf.invalid/user/path', { method: 'POST', body: 'payload', headers: { 'x-application-header': 'kept' } });
  assert.equal(await (await process.fetch(sent)).text(), 'guest answer');
  assert.equal(ctx.request, sent, 'the guest handles the request its host sent, not a copy');
  assert.deepEqual(ctx.seen.map(({ entry }) => entry), ['http']);
  // A watch with another key is no request of its host's: it enters neither endpoint.
  const forged = await process.fetch(new Request('https://leaf.invalid/', { headers: { [HOST_WATCH_HEADER]: 'wrong-capability' } }));
  assert.deepEqual([forged.status, forged.headers.get(HOST_INCARNATION_HEADER), ctx.handlers], [404, null, 1]);
}
for (const admitted of [false, true]) {
  // The guest's request signal is its host's call: cancelling the call
  // aborts it, and a clone or copy the guest forwards with it.
  const ctx = { starts: 0, handlers: 0, seen: [] }, process = new NimbusProcess(ctx, {});
  const pinned = await incarnation(process);
  const caller = new AbortController();
  const sent = admitted ? new Request(request(pinned), { signal: caller.signal })
    : new Request('https://leaf.invalid/', { method: 'POST', body: 'payload', signal: caller.signal });
  assert.equal(await (await process.fetch(sent)).text(), 'guest answer');
  assert.equal(ctx.signal.aborted, false);
  caller.abort(new DOMException('The caller left the request', 'AbortError'));
  assert.equal(ctx.signal.aborted, true, `${admitted ? 'an admitted' : 'a validated'} request: the guest sees its caller leave as its signal`);
  assert.deepEqual(ctx.forwarded.map((signal) => signal.aborted), [true, true], 'a clone or copy of the request the guest forwards is abandoned with it');
}
{
  // The leaf asks the platform for the request signal it hands its guest,
  // unless the program turned it off.
  const flags = (compatibilityFlags) => observeResidentConfig({ compatibilityDate: '2026-09-26', mainModule: 'm.js', modules: { 'm.js': '' }, compatibilityFlags }, capability).compatibilityFlags;
  assert.deepEqual(flags(undefined), ['enable_request_signal', 'request_signal_passthrough']);
  assert.deepEqual(flags(['nodejs_compat', 'disable_request_signal']), ['nodejs_compat', 'disable_request_signal', 'request_signal_passthrough']);
  const own = ['request_signal_passthrough'];
  assert.deepEqual(flags(own), ['request_signal_passthrough', 'enable_request_signal']);
  assert.deepEqual(own, ['request_signal_passthrough'], "the program's own list is not changed in place");
}
{
  // A guest that reflects on its own class cannot learn the capability, so
  // its 410 can never pass for the adapter's branded refusal.
  const forging = observeResidentConfig({
    compatibilityDate: '2026-09-26', mainModule: 'guest.js', modules: {
      'guest.js': `import { DurableObject } from "cloudflare:workers";
export class NimbusProcess extends DurableObject {
  async handleHttpRequest() {
    const source = this.constructor.toString() + Object.getPrototypeOf(this.constructor).toString();
    const found = [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    return new Response(JSON.stringify(found), { status: 410 });
  }
}`,
    },
  }, capability);
  const { NimbusProcess: Forging } = await importModuleSet(forging.modules, forging.mainModule);
  const process = new Forging({}, {});
  const response = await call(process, 'fetch', request(await incarnation(process)));
  assert.equal(response.status, 410);
  assert.equal(JSON.parse(await response.text()).includes(capability), false, 'the capability is not in any class source a guest can read');
}
