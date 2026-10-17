// Peer placement escapes the isolates already in use: a sibling that reports
// the isolate of a process this coordinator hosts, or of one being placed at
// the same time, is passed over for the next (audit FAB-3). Best effort: once
// every attempt co-locates, the last one is used.
import assert from 'node:assert/strict';
import { createFacetCtx, createFacetWorld, createPeerNamespace } from './lib/facet-host-harness.mjs';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';

adoptCtxExports({ SupervisorRPC: (options) => ({ props: options.props }) });
const boot = { kind: 'code', code: { compatibilityDate: '2026-09-26', compatibilityFlags: [], mainModule: 'worker.js', modules: { 'worker.js': 'export class NimbusProcess {}' } } };

function setup() {
  const world = createFacetWorld(() => ({ async startProcess() { return { ok: true }; }, async handleHttpRequest() { return new Response('ok'); } }), { resolveConfig: false });
  // Every process's first sibling lands in one isolate; its later siblings each in their own.
  const onPeer = (peer) => { if (peer.ctx.id.toString().endsWith(':0')) peer.isolateToken = 'shared-isolate'; };
  const { ns } = createPeerNamespace(world, { LOADER: world.loader }, { onPeer });
  const ctx = createFacetCtx(world, 'placement-owner');
  const host = processHostFor(ctx, { NIMBUS_PROCESS_HOST: 'peer', NIMBUS_SESSION: ns }, () => { throw new Error('peer mode does not read the local disk'); });
  const open = (pid) => host.open({ pid, workerKey: `nimbus-process:placement-owner:${pid}`, writerId: crypto.randomUUID(), startArgs: {}, boot });
  return { open };
}
const sibling = (hosted) => /peer '[^']*:proc:\d+:(\d+)'/.exec(hosted.describe())?.[1];

{
  // One after the other: the second process passes over the isolate the first runs in.
  const { open } = setup();
  const first = await open(21), second = await open(22);
  assert.equal(sibling(first), '0');
  assert.equal(sibling(second), '1', `a process is not placed in an isolate another already runs in: ${second.describe()}`);
  // Released, its isolate is free again.
  await first.release();
  const third = await open(23);
  assert.equal(sibling(third), '0', `a released process's isolate is free again: ${third.describe()}`);
  await Promise.all([second.release(), third.release()]);
}
{
  // At the same time: the two placements cannot both take the shared isolate.
  const { open } = setup();
  const [a, b] = await Promise.all([open(31), open(32)]);
  assert.deepEqual([sibling(a), sibling(b)].sort(), ['0', '1'], `concurrent placements reserve their isolates: ${a.describe()} / ${b.describe()}`);
  await Promise.all([a.release(), b.release()]);
}
console.log('peer-placement-isolates: a process is placed outside the isolates in use, at once or one after the other');
