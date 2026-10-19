import assert from 'node:assert/strict';
import { settledScope } from './lib/response-scope.mjs';
import { createFacetCtx, createFacetWorld, createPeerNamespace } from './lib/facet-host-harness.mjs';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { peerHostFor } from '../../packages/worker/src/session/rpc.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { runColdStart } from '../../packages/fabric/src/generation.ts';
import { hostActivity } from '../../packages/fabric/src/host-activity.ts';
import { peerPlacement } from '../../packages/fabric/src/process-host.ts';
import { HOSTED_RESIDENCY_HEADER, HOSTED_WEBSOCKET_CAPABILITY_HEADER, isHostedResidency } from '../../packages/fabric/src/peer-host.ts';

adoptCtxExports({ SupervisorRPC: (options) => ({ props: options.props }) });
const boot = { kind: 'code', code: { compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'], mainModule: 'worker.js', modules: { 'worker.js': 'export class NimbusProcess {}' } } };
const turns = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function setup(delayed = false) {
  const world = createFacetWorld(() => ({ async startProcess() { return { ok: true }; }, async handleHttpRequest() { return new Response('ok'); } }), { resolveConfig: false });
  const { ns, stubs, peers } = createPeerNamespace(world, { LOADER: world.loader });
  const sent = Promise.withResolvers(), delivered = Promise.withResolvers();
  const env = { NIMBUS_PROCESS_HOST: 'peer', NIMBUS_SESSION: {
    idFromName: ns.idFromName, idFromString: ns.idFromString,
    get(name) {
      const stub = ns.get(name);
      return { ...stub, supervisorOp(envelope) {
        if (delayed && envelope.op === 'hostProcess') { sent.resolve(); return delivered.promise.then(() => stub.supervisorOp(envelope)); }
        return stub.supervisorOp(envelope);
      } };
    },
  } };
  const ctx = createFacetCtx(world, 'owner');
  const open = (context = ctx) => processHostFor(context, env, () => { throw new Error('peer mode does not read the local disk'); });
  const params = { pid: 11, workerKey: 'nimbus-process:owner:11', writerId: crypto.randomUUID(), startArgs: {}, boot };
  return { world, ctx, stubs, peers, sent, delivered, open, params };
}

for (const reset of [false, true]) {
  const t = setup(true), host = t.open();
  const pending = host.open(t.params);
  void pending.catch(() => {});
  await t.sent.promise;
  assert.equal((await t.ctx.storage.list({ prefix: 'process-peer:' })).size, 1);
  if (reset) {
    const resumed = createFacetCtx(t.world, 'owner', t.ctx.storage.rows);
    t.open(resumed);
    await runColdStart(resumed);
  } else await host.close();
  assert.equal((await t.ctx.storage.list({ prefix: 'process-peer:' })).size, 0);
  t.delivered.resolve();
  const result = await pending.then(value => ({ value }), error => ({ error }));
  if (result.value) await result.value.release();
  assert.ok(result.error, 'a cancelled delayed open must fail even after coordinator reset');
  assert.equal(t.world.boots.length, 0, 'no guest code executes after the placement was released');
  const peer = [...t.peers.values()][0];
  assert.equal(await peer.ctx.storage.get('hosting-cancelled:' + t.params.workerKey), true);
}

{
  const t = setup(), host = t.open(), entered = Promise.withResolvers(), deliver = Promise.withResolvers();
  const get = host.ns.get.bind(host.ns);
  host.ns.get = (name) => {
    const stub = get(name), fetch = stub.fetch.bind(stub);
    return { ...stub, async fetch(request) {
      if (isHostedResidency(request)) { entered.resolve(); await deliver.promise; request.signal.throwIfAborted(); }
      return fetch(request);
    } };
  };
  const opening = host.open(t.params); void opening.catch(() => {});
  await entered.promise;
  await host.close();
  deliver.resolve();
  await assert.rejects(opening, /abort/i, 'release while the residency upgrade is pending cannot publish a live handle');
  await turns();
  assert.equal(t.world.liveFacets().length, 0);
  assert.equal(t.stubs.filter(stub => !stub.disposed).length, 0);
  assert.equal((await t.ctx.storage.list({ prefix: 'process-peer:' })).size, 0);
}

{
  const t = setup(), host = t.open(), process = await host.open(t.params);
  await process.started; await turns();
  const placement = await peerPlacement(t.ctx, t.params.pid);
  assert.equal(placement.workerKey, t.params.workerKey);
  const peer = t.peers.get(placement.peerName);
  const before = await peer.peerHost.inspect(placement.workerKey);
  assert.equal(before.found, true);
  assert.equal(before.facet, t.world.boots[0].facetName);
  assert.equal([...peer.peerHost.records.values()][0].residencies.size, 1, 'one passive socket belongs to this coordinator incarnation');
  const unauthorized = await peer.peerHost.reside(new Request('https://peer.invalid/', { headers: {
    [HOSTED_RESIDENCY_HEADER]: placement.workerKey, [HOSTED_WEBSOCKET_CAPABILITY_HEADER]: 'wrong-capability',
  } }));
  assert.equal(unauthorized.status, 404, 'a derived worker key cannot claim coordinator residency');
  assert.equal(t.stubs.filter(stub => !stub.disposed).length, 0, 'idle owns no peer RPC stub');
  const lease = hostActivity(t.ctx).acquire(); await turns();
  assert.equal(t.stubs.filter(stub => !stub.disposed).length, 1, 'only the active fetch watch owns a stub');
  const minted = t.stubs.length;
  assert.equal(await (await process.handleHttpRequest(new Request('http://process/'), settledScope())).text(), 'ok');
  assert.equal(t.stubs.length, minted, 'a data call while the host is observed shares the observation\'s stub');
  lease.release(); await turns();
  assert.equal(t.stubs.filter(stub => !stub.disposed).length, 0);
  assert.equal(await (await process.handleHttpRequest(new Request('http://process/'), settledScope())).text(), 'ok');
  await turns();
  assert.equal(t.stubs.filter(stub => !stub.disposed).length, 0, 'a data call does not retain its routing stub');
  await process.release();
  assert.equal(t.stubs.filter(stub => !stub.disposed).length, 0);
  assert.equal(await peerPlacement(t.ctx, t.params.pid), null);
  assert.equal([...peer.peerHost.records.values()][0].residencies.size, 0, 'bounded cancellation closes residency before replying');
  assert.deepEqual(await peer.peerHost.inspect(placement.workerKey), { found: false, incarnation: before.incarnation, facet: null, coordinator: null, residencies: 0, watchers: 0 });
}
{
  const t = setup();
  const ns = t.open().ns;
  let replyResources = 0;
  const get = ns.get.bind(ns);
  ns.get = (name) => {
    const stub = get(name), send = stub.supervisorOp.bind(stub);
    stub.supervisorOp = async (envelope) => {
      const value = await send(envelope);
      if (value && typeof value === 'object') {
        replyResources++;
        Object.defineProperty(value, Symbol.dispose, { configurable: true, value() { replyResources--; } });
      }
      return value;
    };
    return stub;
  };
  const host = processHostFor(t.ctx, { NIMBUS_PROCESS_HOST: 'peer', NIMBUS_SESSION: ns }, () => { throw new Error('no local disk'); });
  const process = await host.open({ ...t.params, workerKey: 'reply-owner', writerId: crypto.randomUUID() });
  await process.started; await turns();
  assert.equal(replyResources, 0, 'bounded peer replies do not retain their incoming native RPC session');
  await process.release();
  assert.equal(replyResources, 0);
}
for (const code of [1000, 1005, 1006, 'error']) {
  const t = setup(), host = t.open(), process = await host.open(t.params);
  await process.started;
  const lease = hostActivity(t.ctx).acquire(); await lease.ready;
  const peer = [...t.peers.values()][0];
  const record = [...peer.peerHost.records.values()][0];
  // The leaf's adapter is imported for real the first time: that is I/O, not a turn.
  for (let i = 0; i < 400 && !record.watchers.size; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const server = [...record.watchers.keys()][0];
  assert.equal(hostActivity(peer.ctx).owners.size, 1);
  const replies = [], close = server.close.bind(server);
  server.close = (...args) => { replies.push({ args, owners: record.watchers.size }); close(...args); };
  // An incoming transport failure can carry a reserved code, or only an error.
  server.readyState = 3;
  const event = new Event(code === 'error' ? 'error' : 'close');
  if (code !== 'error') Object.assign(event, { code, reason: 'remote ended', wasClean: code === 1000 });
  try {
    server.dispatchEvent(event);
    assert.equal(record.watchers.size, 0, 'every close/error releases the peer activity owner');
    assert.equal(hostActivity(peer.ctx).owners.size, 0, 'the peer releases its own facet observation');
    assert.deepEqual(replies, [{ args: [], owners: 0 }], 'cleanup precedes an argument-free reply, never an echoed reserved code');
    server.dispatchEvent(event);
    assert.equal(record.watchers.size, 0, 'duplicate close/error is harmless');
  } finally { lease.release(); await process.release(); }
}
// A cancel of a process an earlier life of the peer hosted names the facet
// it ran in. That name is given out again from 0 after the peer restarted:
// a live process holding it now is not the cancelled one, and keeps running.
{
  const t = setup(), host = t.open(), process = await host.open(t.params);
  await process.started; await turns();
  const placement = await peerPlacement(t.ctx, t.params.pid);
  const peer = t.peers.get(placement.peerName);
  const name = (await peer.peerHost.inspect(placement.workerKey)).facet;
  const earlier = 'nimbus-process:owner:earlier-life';
  await peer.ctx.storage.put(`hosting:${earlier}`, { coordinatorDoId: 'owner', workerKey: earlier, capability: 'gone', incarnation: 'an-earlier-life', facet: name });
  assert.deepEqual(await peer.peerHost.cancel(earlier), { cancelled: true });
  assert.ok(t.world.liveFacets().includes(name), `the process holding ${name} now still runs`);
  assert.equal(await (await process.handleHttpRequest(new Request('http://process/'), settledScope())).text(), 'ok');
  await process.release();
  assert.ok(!t.world.liveFacets().includes(name), 'and its own release ends it');
}
// A cancel after the peer itself restarted, with nothing given the name
// since: the facet the cancelled process left running is its own, and is
// ended and deleted, though the peer's earlier life never released it.
{
  const t = setup(), host = t.open(), process = await host.open(t.params);
  await process.started; await turns();
  const placement = await peerPlacement(t.ctx, t.params.pid);
  const peer = t.peers.get(placement.peerName);
  const name = (await peer.peerHost.inspect(placement.workerKey)).facet;
  peer.resetBy = new Error('the peer restarted');
  await process.release();
  assert.ok(!t.world.liveFacets().includes(name), `the cancelled process's facet ${name} is ended`);
}
// A cancel that arrives after the peer restarted twice, the name its record
// names given to another process in between: that process's facet is not
// the cancelled one's, whichever life of the peer gave it the name.
{
  const t = setup(), host = t.open();
  const first = await host.open(t.params);
  await first.started; await turns();
  const placement = await peerPlacement(t.ctx, t.params.pid);
  const peer = t.peers.get(placement.peerName);
  const name = (await peer.peerHost.inspect(placement.workerKey)).facet;
  const restart = () => {
    peer.ctx = createFacetCtx(t.world, placement.peerName, peer.ctx.storage.rows);
    peer.peerHost = peerHostFor(peer.ctx, peer.env);
  };
  restart();
  const secondParams = { ...t.params, pid: 12, workerKey: 'nimbus-process:owner:12', writerId: crypto.randomUUID() };
  const second = await host.open(secondParams);
  await second.started; await turns();
  assert.equal((await peerPlacement(t.ctx, 12)).peerName, placement.peerName, 'both processes are hosted by one peer');
  assert.equal((await peer.peerHost.inspect(secondParams.workerKey)).facet, name, 'the restarted peer gave the second process the same name');
  restart();
  await peer.peerHost.cancel(placement.workerKey);
  assert.ok(t.world.liveFacets().includes(name), 'the first process\'s cancel leaves the second one\'s facet running');
  await peer.peerHost.cancel(secondParams.workerKey);
  assert.ok(!t.world.liveFacets().includes(name), 'and the second one\'s cancel ends it');
}
console.log('peer-open-ownership: cancellation fences delayed opens and only live calls own stubs');
