#!/usr/bin/env bun
// Which resolver a journalled worker launch re-drives through.
//
// `WorkerRecipe.resident` is not a boolean. It is the interpreter image
// (`{ runtime: 'python' | 'ruby', argv }`) of a socket server the SESSION
// launched for itself, and it is what routes a recipe's re-drive to the
// session's own image-store fallback: the session persisted that image and
// no embedder was asked about the launch. An embedder's `spawnWorker` — the
// launch Kinu drives, durable or not — never sets it, so its recipe re-drives
// through `hooks.resolveWorkerLaunch`, with the fallback consulted only when
// no embedder hook is composed.
//
// Modelled as the resident-launch-survives-instance-reset test models a
// reset: a new FacetManager over the SAME storage rows, at the next pid
// generation, with nothing carried over in memory.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const evaluate = (config) => ({
  async startProcess() { return { ok: true, mainModule: config.mainModule }; },
  async handleHttpRequest() { return Response.json({ mainModule: config.mainModule }); },
});

function createSession() {
  const disk = createSqliteVfsTestHarness();
  return { storage: new Map(), vfs: new SqliteVFS(disk.sql, disk.ctx) };
}

/**
 * An instance with BOTH resolvers composed and both recording what they were
 * asked, so the test can say which one a recipe reached — not merely that a
 * re-drive happened.
 */
function createInstance(session, generation, label, { embedderModules }) {
  const world = createFacetWorld(evaluate);
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(generation * PID_GEN_STRIDE);
  const ctx = createFacetCtx(world, label, session.storage);
  const asked = { embedder: [], fallback: [] };
  const env = {
    LOADER: world.loader,
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname.replace(/^\//, '');
        return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
      },
    },
  };
  const manager = new FacetManager(ctx, env, processes, new PortRegistry(), processHostFor, {
    notify: () => {},
    resolveWorkerLaunch: async (recipe) => {
      asked.embedder.push(recipe);
      return { env: null, globalOutbound: undefined, modules: embedderModules, mainModule: 'runner.js' };
    },
    resolveWorkerLaunchFallback: async (recipe) => {
      asked.fallback.push(recipe);
      return { env: null, globalOutbound: undefined, modules: { 'worker.js': 'export default {} // fallback' } };
    },
  });
  manager.setVfs(session.vfs);
  return { ctx, world, processes, manager, asked };
}

const settle = async (predicate, tries = 400) => {
  for (let i = 0; i < tries && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
};

const RUNNER_V1 = 'export default { fetch: () => new Response("v1") };';
const RUNNER_V2 = 'export default { fetch: () => new Response("v2") };';

// ── 1. an embedder worker recipe re-drives through hooks.resolveWorkerLaunch ─
{
  const session = createSession();
  const gen1 = createInstance(session, 1, 'embedder', { embedderModules: { 'runner.js': RUNNER_V1 } });

  // Embedder-owned: digests come from the embedder's bookkeeping, no image
  // is persisted by the session, and nothing marks the recipe `resident`.
  const spawned = await gen1.manager.spawnWorker(RUNNER_V1, 'kinu slate', '/home/user', {
    mainModule: 'runner.js',
    durable: { owner: 'slate:alpha', image: { runner: 'sha-runner-1', application: 'sha-app-1' } },
  });
  const row = session.storage.get('resident-launch:' + spawned.pid);
  assert.ok(row, 'journalled');
  assert.equal(row.recipe.resident, undefined, 'an embedder worker recipe carries no interpreter image');
  assert.deepEqual(gen1.asked, { embedder: [], fallback: [] }, 'the first launch resolves nothing — it has its inputs');

  // The reset. The replacement's embedder resolver answers with NEW content,
  // which is exactly the point of asking it: the embedder's store decides.
  const gen2 = createInstance(session, 2, 'embedder', { embedderModules: { 'runner.js': RUNNER_V2 } });
  await gen2.manager.pumpResidentLaunches();
  await settle(() => gen2.world.configs.size > 0);

  assert.equal(gen2.asked.fallback.length, 0, 'the image-store fallback was NOT consulted');
  assert.equal(gen2.asked.embedder.length, 1, 'the embedder resolver was, once');
  const recipe = gen2.asked.embedder[0];
  assert.equal(recipe.kind, 'worker');
  assert.equal(recipe.owner, 'slate:alpha', 'keyed by the owner the embedder declared');
  assert.deepEqual(recipe.image, { runner: 'sha-runner-1', application: 'sha-app-1' }, "with the embedder's own digests");
  assert.equal(recipe.mainModule, 'runner.js');
  assert.equal(recipe.resident, undefined);

  const [config] = [...gen2.world.configs.values()];
  assert.equal(config.mainModule, 'runner.js');
  assert.equal(config.modules['runner.js'], RUNNER_V2, "the re-driven process boots what the embedder resolved, not what was launched");

  const rows = [...session.storage.keys()].filter((k) => k.startsWith('resident-launch:'));
  assert.equal(rows.length, 1);
  const newPid = Number(rows[0].slice('resident-launch:'.length));
  assert.ok(newPid > 2 * PID_GEN_STRIDE, 'a pid of the replacement generation');
  assert.equal(gen2.processes.get(newPid)?.state, 'running');
  gen2.manager.kill(newPid);
}

// ── 2. the contrast: an interpreter resident recipe takes the fallback ───
{
  const session = createSession();
  const gen1 = createInstance(session, 1, 'interpreter', { embedderModules: { 'runner.js': RUNNER_V1 } });

  // What the session's own python/ruby launch looks like: `resident` is the
  // interpreter image, and the session persists the launch's image blobs.
  const spawned = await gen1.manager.spawnWorker(RUNNER_V1, 'python app.py', '/home/user', {
    resident: { runtime: 'python', argv: ['python', 'app.py'] },
  });
  const row = session.storage.get('resident-launch:' + spawned.pid);
  assert.ok(row, 'journalled');
  assert.deepEqual(row.recipe.resident, { runtime: 'python', argv: ['python', 'app.py'] }, 'the recipe records the interpreter image, not a flag');

  const gen2 = createInstance(session, 2, 'interpreter', { embedderModules: { 'runner.js': RUNNER_V2 } });
  await gen2.manager.pumpResidentLaunches();
  await settle(() => gen2.world.configs.size > 0);

  assert.equal(gen2.asked.embedder.length, 0, "the embedder's resolver is not asked about the session's own interpreter");
  assert.equal(gen2.asked.fallback.length, 1, 'the image-store fallback is');
  assert.deepEqual(gen2.asked.fallback[0].resident, { runtime: 'python', argv: ['python', 'app.py'] });
  const [config] = [...gen2.world.configs.values()];
  assert.equal(config.mainModule, 'worker.js', 'the interpreter runner boots from the default main module');
  assert.match(config.modules['worker.js'], /fallback/);

  const rows = [...session.storage.keys()].filter((k) => k.startsWith('resident-launch:'));
  gen2.manager.kill(Number(rows[0].slice('resident-launch:'.length)));
}

console.log('PASS resident-worker-redrive-resolver');
