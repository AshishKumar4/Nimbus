import assert from 'node:assert/strict';
import './lib/workerd-fixed-length-stream.mjs';
import { createFacetWorld, createFacetCtx, createPeerNamespace } from './facet-host-harness.mjs';
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

for (const mode of ['facet', 'peer']) for (const route of ['port', 'direct']) for (const ending of ['eof', 'leave', 'partial-leave', 'error', 'short', 'long', 'no-body']) {
  let source, cancelled = false, watching = 0;
  const world = createFacetWorld(() => ({
    startProcess: async () => ({}),
    handleHttpRequest: async () => ending === 'no-body'
      ? new Response(null, { status: 204 })
      : new Response(new ReadableStream({ start(controller) { source = controller; }, cancel() { cancelled = true; } }), { headers: { 'Content-Length': '3' } }),
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
    if (route === 'port') {
      const ports = new PortRegistry(); ports.setOutput(output); ports.bindFacetStub(11, process); ports.register(3011, 11);
      response = await ports.routeRequest(3011, new Request('https://app.invalid/', { signal: client.signal }), '/');
    } else {
      const { scope, owner } = responseScope(client.signal);
      response = relayRpcBody(await process.handleHttpRequest(new Request('https://app.invalid/'), scope), 'GET', owner);
    }
    await turns();
    if (ending === 'no-body') {
      assert.equal(response.status, 204);
      assert.equal(watching, 0, `${label}: a response without a body owns nothing past its headers`);
      assert.ok(peers?.cancels.every((cancel) => cancel.disposed) ?? true, `${label}: the peer's cancel stub is disposed`);
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
    assert.ok(peers === null || (peers.cancels.length === 1 && peers.cancels[0].disposed), `${label}: the peer's cancel stub lives for this response only`);
  } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); neighbor.close(); await process.release(); }
}
assert.ok(published.length > 0, 'the port relay published the process output before its body');
console.log('process-host-response-ownership: port and direct relays own work until EOF, error, mismatch or a leaving client, on both hosts');
