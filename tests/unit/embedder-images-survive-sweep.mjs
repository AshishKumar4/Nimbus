#!/usr/bin/env bun
// An embedder's images survive the image store's sweep.
//
// An embedder keeps content-addressed images of its own in
// /.nimbus/facet-images (facetImagePath): a durable worker's runner, its text
// modules. It removes them itself. The store's sweep removes what the store
// wrote, and nothing else. Red before: the sweep unlinked every image there
// that no running process booted from. After a reset, the first launch's
// sweep took a durable app's text module, and the app's next re-drive failed
// with ENOENT.

import assert from 'node:assert/strict';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { FACET_IMAGE_DIR, facetImageDigest, facetImagePath } from '../../packages/fabric/src/process-fabric.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import { launchManager, launchSession } from './lib/facet-launch-harness.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const LIB = 'export const answer = 42;\n';
const session = launchSession();
const kernel = session.vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.mkdir(FACET_IMAGE_DIR, { recursive: true, mode: 0o755 });
const libPath = facetImagePath(await facetImageDigest(LIB));
kernel.writeFile(libPath.slice(1), LIB, { mode: 0o644 });

/** An instance of the session at `generation`, re-driving durable apps from the session's image store. */
function instance(generation) {
  const launched = launchManager('embedder-images', {
    session, generation,
    evaluate: () => ({
      async startProcess() { return { ok: true }; },
      async handleHttpRequest() { return new Response('ok'); },
    }),
    hooks: {
      requestLaunchTurn: () => { setTimeout(() => { void launched.manager.pumpResidentLaunches(); }, 0); },
      resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(session.vfs, recipe),
    },
  });
  return launched;
}

const bootedWithLib = (world) => [...world.configs.values()].some((config) => config.modules?.['lib.js'] === LIB);
const until = async (ready, what) => {
  for (let i = 0; i < 400 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ready(), `timed out waiting for ${what}`);
};

const gen1 = instance(1);
await gen1.manager.spawnWorker('export class NimbusProcess {}', 'durable app', '/home/user', {
  vfsTextModules: { 'lib.js': libPath },
  durable: { owner: 'app:one' },
});
assert.ok(bootedWithLib(gen1.world), 'the durable app booted with the embedder\'s text module');

// A reset: the replacement's first launch writes its own images, and sweeps.
const gen2 = instance(2);
await gen2.manager.spawnNode('setInterval(() => {}, 1000);', { command: 'node tick.js', filename: '/home/user/tick.js', cwd: '/home/user' });
await until(() => gen2.world.configs.size > 0, 'the replacement\'s launches to boot');
assert.equal(kernel.exists(libPath.slice(1)), true, 'the embedder\'s image survives the store\'s sweep');

// And another: the durable app's re-drive still finds its text module.
const gen3 = instance(3);
await gen3.manager.pumpResidentLaunches();
await until(() => bootedWithLib(gen3.world), 'the durable app\'s re-drive to boot with its text module');

console.log('embedder-images-survive-sweep: an embedder\'s images survive the store\'s sweep, and its durable app re-drives');
