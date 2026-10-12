import assert from 'node:assert/strict';
import { createFacetCtx, createFacetWorld, createPeerNamespace } from './facet-host-harness.mjs';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { HOSTED_WATCH_HEADER } from '../../packages/fabric/src/peer-host.ts';

adoptCtxExports({ SupervisorRPC: options => ({ props: options.props }) });
const turns = async () => { for (let i = 0; i < 160; i++) await Promise.resolve(); };
const boot = { kind: 'code', code: { compatibilityDate: '2026-09-26', mainModule: 'worker.js', modules: { 'worker.js': 'export class NimbusProcess {}' } } };
let guestCalls = 0, dataCalls = 0, blocked = false;
const pendingWatch = Promise.withResolvers();
const world = createFacetWorld(() => ({
  async startProcess() { return {}; },
  async handleHttpRequest(request) { guestCalls++; return new Response(await request.text()); },
}), { resolveConfig: false });
const { ns, peers } = createPeerNamespace(world, { LOADER: world.loader });
const ctx = createFacetCtx(world, 'data-leg');
const host = processHostFor(ctx, { NIMBUS_PROCESS_HOST: 'peer', NIMBUS_SESSION: {
  idFromName: ns.idFromName, idFromString: ns.idFromString,
  get(name) {
    const stub = ns.get(name);
    return { ...stub,
      async fetch(request) {
        if (blocked && request.headers.has(HOSTED_WATCH_HEADER)) await pendingWatch.promise;
        return stub.fetch(request);
      },
      supervisorOp(envelope) {
        if (envelope.op === 'routeHostedHttp') dataCalls++;
        return stub.supervisorOp(envelope);
      },
    };
  },
} }, () => { throw new Error('no local peer disk'); });
const params = { pid: 31, workerKey: 'nimbus-process:data-leg:31', writerId: crypto.randomUUID(), boot };
const process = await host.open(params);
await process.started; await turns();
blocked = true;
const request = process.handleHttpRequest(new Request('https://app.invalid/data', { method: 'POST', body: 'kept payload' }));
void request.catch(() => {});
try {
  await turns();
  assert.equal(dataCalls, 1, 'authenticated data admission uses its data leg, not a separate pending watch response');
  assert.equal(guestCalls, 1, 'a valid pinned actor can answer while independent observation is opening');
} finally {
  blocked = false; pendingWatch.resolve();
  const response = await request;
  assert.equal(await response.text(), 'kept payload');
  await process.release();
}

// Stored-only, failed, deliberately closed and capability-mismatched records
// must be refused before they can resolve/dispatch a fresh facet.
for (const kind of ['cold', 'failed', 'closed', 'capability']) {
  // The released key is tombstoned; a new open gives this case its own record.
  const key = params.workerKey + ':' + kind;
  const value = await host.open({ ...params, pid: params.pid + 1, workerKey: key, writerId: crypto.randomUUID() });
  await value.started; await turns();
  const current = [...peers.values()].find(item => item.peerHost.records.has(key));
  const open = current.peerHost.records.get(key), before = guestCalls, boots = world.boots.length;
  if (kind === 'cold') current.peerHost.records.delete(key);
  else if (kind === 'failed') open.failure = new Error('the recorded facet was lost');
  else if (kind === 'closed') open.closed = true;
  const answer = await current.peerHost.routeHttp(key, { method: 'GET', url: 'https://app.invalid/', headers: [], capability: kind === 'capability' ? 'wrong' : open.webSocketCapability })
    .then(reply => ({ reply }), error => ({ error }));
  assert.ok(answer.error || answer.reply.hostLost, kind + ' cannot yield a guest answer');
  assert.equal(guestCalls, before, kind + ' is rejected before guest dispatch');
  assert.equal(world.boots.length, boots, kind + ' cannot boot a fresh guest');
  if (kind === 'cold') current.peerHost.records.set(key, open);
  await value.release();
}
await host.close();
