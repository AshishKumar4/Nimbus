import assert from 'node:assert/strict';
import { createFacetWorld, createPeerNamespace } from './lib/facet-host-harness.mjs';
import { launchManager } from './lib/facet-launch-harness.mjs';
import { deriveResidentOwner } from '../../packages/worker/src/facets/resident-identity.ts';
import { reservePort } from '../../packages/worker/src/session/port-capability.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });
const world = createFacetWorld(() => ({ startProcess: async () => ({}) }), { resolveConfig: false });
const { ns } = createPeerNamespace(world, { LOADER: world.loader });
const published = [];
const gen = launchManager('durable-refusal', { env: { NIMBUS_PROCESS_HOST: 'peer', NIMBUS_SESSION: ns }, hooks: { onSpawn: (...args) => published.push(args) } });

try {
  for (const runtime of ['python', 'ruby']) {
    const started = await gen.manager.spawnWorker('export default {}', runtime + ' unreserved', '/home/user', {
      resident: { runtime, argv: [runtime, 'serve'] },
    });
    assert.ok(started.pid > 0, 'an interpreter journal identity is not a retained storage request');
    gen.manager.kill(started.pid);
  }
  const afterEphemeral = gen.processes.getAll().length;
  published.length = 0;
  await assert.rejects(gen.manager.spawnWorker('export default {}', 'durable', '/home/user', { durable: { owner: 'owned' } }), /durable.*facet-hosted/);
  assert.deepEqual(published, [], 'an explicit durable worker is refused before its pid is announced');
  const owner = await deriveResidentOwner('/home/user', ['server.js']);
  await reservePort(gen.ctx, { owner, preferredPort: 3000, occupiedPorts: new Set() });
  await assert.rejects(gen.manager.spawnNode('require("http").createServer().listen(3000)', { cwd: '/home/user', argv: ['server.js'], attachedTty: true }), /durable.*facet-hosted/);
  assert.equal(gen.processes.getAll().length, afterEphemeral, 'unsupported durable hosting does not allocate a pid');
  assert.deepEqual(published, [], 'unsupported durable hosting never announces a spawn');
} finally { await gen.manager.closeLaunches(); }
