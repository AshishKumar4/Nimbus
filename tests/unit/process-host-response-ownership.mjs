import assert from 'node:assert/strict';
import { createFacetWorld, createFacetCtx, createPeerNamespace } from './facet-host-harness.mjs';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { hostActivity, HOST_INCARNATION_HEADER } from '../../packages/fabric/src/host-activity.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });
const turns = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
const boot = { kind: 'code', code: { compatibilityDate: '2026-09-26', compatibilityFlags: [], mainModule: 'worker.js', modules: { 'worker.js': 'export class NimbusProcess {}' } } };

for (const mode of ['facet', 'peer']) for (const ending of ['eof', 'cancel', 'error']) {
  let output, cancelled = false, watching = 0;
  const world = createFacetWorld(() => ({
    startProcess: async () => ({}),
    handleHttpRequest: async () => new Response(new ReadableStream({ start(controller) { output = controller; }, cancel() { cancelled = true; } })),
  }), { resolveConfig: false });
  const ctx = createFacetCtx(world, mode + ending), env = { LOADER: world.loader };
  if (mode === 'peer') env.NIMBUS_SESSION = createPeerNamespace(world, env).ns;
  const host = processHostFor(ctx, { ...env, NIMBUS_PROCESS_HOST: mode }, () => { throw new Error('no disk reads'); });
  const process = await host.open({ pid: 11, workerKey: 'body-' + ending, writerId: crypto.randomUUID(), boot });
  await process.started; await turns();
  const remove = hostActivity(ctx).observe(async () => new Response(new ReadableStream({
    start() { watching++; }, cancel() { watching--; },
  }), { headers: { [HOST_INCARNATION_HEADER]: 'neighbor' } }), () => assert.fail('no host is lost'));
  let response;
  try {
    response = await process.handleHttpRequest(new Request('https://app.invalid/'));
    assert.equal(watching, 1, 'the coordinator owns stream work after response headers');
    const reader = response.body.getReader();
    if (ending === 'cancel') {
      await reader.cancel(); await turns();
      assert.equal(cancelled, true, 'consumer cancellation reaches the source');
    } else {
      output.enqueue(new Uint8Array([1, 2, 3]));
      assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
      assert.equal(watching, 1, 'partial delivery is not completion');
      if (ending === 'eof') { output.close(); assert.equal((await reader.read()).done, true); }
      else { output.error(new Error('body failed')); await assert.rejects(reader.read(), /body failed/); }
      await turns();
    }
    reader.releaseLock();
    assert.equal(watching, 0, 'EOF, cancellation and failure release stream ownership');
  } finally { if (response && !response.body.locked) await response.body.cancel().catch(() => {}); remove(); await process.release(); }
}
