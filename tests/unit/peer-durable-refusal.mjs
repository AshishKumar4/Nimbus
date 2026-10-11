import assert from 'node:assert/strict';
import { createFacetWorld, createPeerNamespace } from './facet-host-harness.mjs';
import { launchManager } from './lib/facet-launch-harness.mjs';
import { deriveResidentOwner } from '../../packages/worker/src/facets/resident-identity.ts';
import { reservePort } from '../../packages/worker/src/session/port-capability.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });
const world = createFacetWorld(() => ({ startProcess: async () => ({}) }), { resolveConfig: false });
const { ns } = createPeerNamespace(world, { LOADER: world.loader });
const published = [];
const gen = launchManager('durable-refusal', { env: { NIMBUS_PROCESS_HOST: 'peer', NIMBUS_SESSION: ns }, hooks: { onSpawn: (...args) => published.push(args) } });
const before = gen.processes.getAll().length;
try {
  await assert.rejects(gen.manager.spawnWorker('export default {}', 'durable', '/home/user', { durable: { owner: 'owned' } }), /durable.*facet-hosted/);
  assert.deepEqual(published, [], 'an explicit durable worker is refused before its pid is announced');
  const owner = await deriveResidentOwner('/home/user', ['server.js']);
  await reservePort(gen.ctx, { owner, preferredPort: 3000, occupiedPorts: new Set() });
  await assert.rejects(gen.manager.spawnNode('require("http").createServer().listen(3000)', { cwd: '/home/user', argv: ['server.js'], attachedTty: true }), /durable.*facet-hosted/);
  assert.equal(gen.processes.getAll().length, before, 'unsupported durable hosting does not allocate a pid');
  assert.deepEqual(published, [], 'unsupported durable hosting never announces a spawn');
} finally { await gen.manager.closeLaunches(); }
