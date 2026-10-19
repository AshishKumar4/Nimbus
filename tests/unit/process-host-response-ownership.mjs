import assert from 'node:assert/strict';
import './lib/workerd-fixed-length-stream.mjs';
import { createFacetWorld, createFacetCtx, createPeerNamespace } from './lib/facet-host-harness.mjs';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { hostActivity, HOST_INCARNATION_HEADER } from '../../packages/fabric/src/host-activity.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { PortRegistry, relayRpcBody, responseScope } from '../../packages/core/src/runtime/port-registry.ts';

// A process owns work for a response until its caller is done with the body:
// the registry's relay settling (EOF, error, a framing mismatch), or the
// client leaving (the scope's signal) while the process is quiet. The direct
// relay (spawnWorker's facet.fetch) owns it the same way.
adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });
const turns = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
const boot = { kind: 'code', code: { compatibilityDate: '2026-09-26', compatibilityFlags: [], mainModule: 'worker.js', modules: { 'worker.js': 'export class NimbusProcess {}' } } };
const published = [];
const output = {
  releaseOutput: async (pid, deliver) => { published.push(pid); deliver(); },
  escapeOutput() {},
};

for (const mode of ['facet', 'peer']) for (const route of ['port', 'direct']) for (const ending of ['eof', 'leave', 'partial-leave', 'error', 'short', 'long', 'no-body', 'leave-before-headers', 'answer-after-leave', 'throw']) {
  let source, cancelled = false, watching = 0, heard = false, handled;
  const handling = Promise.withResolvers();
  const world = createFacetWorld(() => ({
    startProcess: async () => ({}),
    handleHttpRequest: async (request) => {
      handled = request;
      if (ending === 'throw') throw new Error('the handler failed');
      if (ending === 'answer-after-leave') {
        // A handler that answers after its caller left, with a body it then keeps quiet.
        handling.resolve();
        await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }));
        return new Response(new ReadableStream({ start(controller) { source = controller; }, cancel() { cancelled = true; } }));
      }
      if (ending === 'leave-before-headers') {
        // A handler that never answers headers hears its caller leave through its request.
        handling.resolve();
        await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }));
        heard = true;
        throw new Error('the client left before any header');
      }
      return ending === 'no-body'
        ? new Response(null, { status: 204 })
        : new Response(new ReadableStream({ start(controller) { source = controller; }, cancel() { cancelled = true; } }), { headers: { 'Content-Length': '3' } });
    },
  }), { resolveConfig: false });
  const ctx = createFacetCtx(world, `${mode}-${route}-${ending}`), env = { LOADER: world.loader };
  const peers = mode === 'peer' ? createPeerNamespace(world, env) : null;
  if (peers) env.NIMBUS_SESSION = peers.ns;
  const host = processHostFor(ctx, { ...env, NIMBUS_PROCESS_HOST: mode }, () => { throw new Error('no disk reads'); });
  const process = await host.open({ pid: 11, workerKey: `body-${route}-${ending}`, writerId: crypto.randomUUID(), boot });
  await process.started; await turns();
  // Any owned work observes every resident; this one stands for them all.
  const neighbor = hostActivity(ctx).observe(async () => new Response(new ReadableStream({
    start() { watching++; }, cancel() { watching--; },
  }), { headers: { [HOST_INCARNATION_HEADER]: 'neighbor' } }), () => assert.fail('no host is lost'), 'neighbor');
  const client = new AbortController();
  const label = `${mode} ${route} ${ending}`;
  let response;
  try {
    const answered = route === 'port'
      ? (() => { const ports = new PortRegistry(); ports.setOutput(output); ports.bindFacetStub(11, process); ports.register(3011, 11); return ports.routeRequest(3011, new Request('https://app.invalid/', { signal: client.signal }), '/'); })()
      : (async () => { const { scope, owner } = responseScope(client.signal); try { return relayRpcBody(await process.handleHttpRequest(new Request('https://app.invalid/'), scope), 'GET', owner); } catch (error) { owner.fail(error); throw error; } })();
    if (ending === 'answer-after-leave') {
      await handling.promise; await turns();
      client.abort(new DOMException('The client has disconnected', 'AbortError'));
      await answered.then((response) => response.body?.cancel?.().catch(() => {}), () => {});
      await turns();
      assert.equal(cancelled, true, `${label}: a body that came after its caller left is cancelled, though its source is quiet`);
      assert.equal(watching, 0, `${label}: and the work is released`);
      continue;
    }
    if (ending === 'leave-before-headers') {
      await handling.promise; await turns();
      assert.equal(watching, 1, `${label}: the process owns its work while its handler runs`);
      client.abort(new DOMException('The client has disconnected', 'AbortError'));
      const outcome = await answered.then((value) => value.status, (error) => error.message);
      await turns();
      assert.equal(heard, true, `${label}: the handler hears its caller leave before any header`);
      assert.ok(outcome === 502 || /left before any header/.test(outcome), `${label}: ${outcome}`);
      assert.equal(watching, 0, `${label}: and the work is released`);
      assert.ok(peers === null || peers.abandoned.join() === peers.routed.join(), `${label}: the coordinator abandons the peer's request`);
      continue;
    }
    if (ending === 'throw') {
      const outcome = await answered.then((value) => value.status, (error) => error.message);
      await turns();
      assert.ok(outcome === 502 || /the handler failed/.test(outcome), `${label}: ${outcome}`);
      assert.equal(handled.signal.aborted, true, `${label}: a handler whose request failed hears its caller is gone`);
      assert.equal(watching, 0, `${label}: and the work is released`);
      continue;
    }
    response = await answered;
    await turns();
    if (ending === 'no-body') {
      assert.equal(response.status, 204);
      assert.equal(watching, 0, `${label}: a response without a body owns nothing past its headers`);
      assert.equal(handled.signal.aborted, false, `${label}: a delivered response is not one its caller left`);
      assert.deepEqual(peers?.abandoned ?? [], [], `${label}: nothing is sent for a delivered response`);
      continue;
    }
    assert.equal(watching, 1, `${label}: the process owns its work after the response headers`);
    assert.equal(response.body.expectedLength, 3, `${label}: the declared length reaches the wire`);
    const reader = response.body.getReader();
    if (ending.includes('leave')) {
      if (ending === 'partial-leave') { source.enqueue(new Uint8Array([1])); assert.deepEqual((await reader.read()).value, new Uint8Array([1])); }
      // The client goes away while the process writes nothing.
      client.abort(new DOMException('The client has disconnected', 'AbortError'));
      await turns();
      assert.equal(watching, 0, `${label}: a client leaving releases the work at once`);
      if (!cancelled) source.enqueue(new Uint8Array([2]));
      await turns();
      assert.equal(cancelled, true, `${label}: the process's body is cancelled, at its next write at the latest`);
    } else if (ending === 'short' || ending === 'long') {
      source.enqueue(new Uint8Array(ending === 'short' ? 2 : 4)); source.close();
      await assert.rejects(reader.read().then(async (part) => {
        while (!part.done) part = await reader.read();
      }), `${label}: a framing mismatch must fail, never silently truncate or relabel the body`);
      await turns();
    } else {
      source.enqueue(new Uint8Array([1, 2, 3]));
      assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
      assert.equal(watching, 1, `${label}: partial delivery is not completion`);
      if (ending === 'eof') { source.close(); assert.equal((await reader.read()).done, true); }
      else { source.error(new Error('body failed')); await assert.rejects(reader.read(), /body failed/); }
      await turns();
    }
    reader.releaseLock();
    assert.equal(watching, 0, `${label}: EOF, error, mismatch and a leaving client release the work`);
    await turns();
    // A body that will not reach its caller, for whatever reason, is one its handler hears was left.
    assert.equal(handled.signal.aborted, ending !== 'eof', `${label}: the handler hears whether its body was delivered`);
    assert.deepEqual(peers?.abandoned ?? [], ending === 'eof' || peers === null ? [] : peers.routed, `${label}: only an undelivered response is abandoned, once`);
  } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); neighbor.close(); await process.release(); }
}
{
  // A guest whose handler throws took the call; its response is not delivered, which its request's signal says.
  const signals = [];
  const world = createFacetWorld(() => ({ startProcess: async () => ({}), handleHttpRequest: async (request) => { signals.push(request.signal); throw new Error('the handler failed'); } }), { resolveConfig: false });
  const ctx = createFacetCtx(world, 'throwing');
  const host = processHostFor(ctx, { LOADER: world.loader, NIMBUS_PROCESS_HOST: 'facet' }, () => { throw new Error('no disk reads'); });
  const process = await host.open({ pid: 12, workerKey: 'throwing', writerId: crypto.randomUUID(), boot });
  await process.started; await turns();
  for (let i = 0; i < 3; i++) {
    const { scope, owner } = responseScope(new AbortController().signal);
    await assert.rejects(process.handleHttpRequest(new Request('https://app.invalid/'), scope).catch((error) => { owner.fail(); throw error; }), /the handler failed/);
    await turns();
  }
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, true, true], 'each failed request is abandoned at its guest');
  await process.release();
}
assert.ok(published.length > 0, 'the port relay published the process output before its body');
console.log('process-host-response-ownership: port and direct relays own work until EOF, error, mismatch or a leaving client, on both hosts');
