#!/usr/bin/env bun
// A durable application's launch inputs are an image, not a re-ask.
//
// `spawnWorker` for a self-owned durable app persists the launch's code,
// modules, and env as content-addressed blobs under `.nimbus/images/` —
// kernel VFS, so a user process cannot rewrite or delete what its own
// re-drive will boot from — and the journal row names the digests it wrote.
// A reset re-drives the recipe through the session's fallback resolver, which
// reads those blobs back and hands the launch its env and modules again.
//
// An embedder-owned durable spawn is given its digests by the embedder's own
// bookkeeping and resolves through the EMBEDDER's `resolveWorkerLaunch` —
// which still overrides the fallback entirely, including the right to carry
// a live globalOutbound binding the image store can never hold.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import {
  persistDurableWorkerImage,
  resolveDurableWorkerImage,
  DURABLE_IMAGE_DIR,
} from '../../packages/worker/src/facets/durable-images.ts';
import {
  createFacetWorld,
  createFacetCtx,
  createProcessFacetCtx,
} from './facet-host-harness.mjs';
import { runColdStart } from '../../packages/fabric/src/generation.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

function setup({ hooks = {}, storage = new Map(), world, disk } = {}) {
  const boots = [];
  const lines = [];
  if (!world) {
    world = createFacetWorld(() => {
      const boot = { id: `boot-${boots.length + 1}`, served: 0 };
      boots.push(boot);
      return {
        boot,
        async startProcess() { return { ok: true }; },
        async handleHttpRequest() { return Response.json({ boot: boot.id }); },
      };
    });
  }
  const ctx = createFacetCtx(world, 'durable-images-do', storage);
  const env = { LOADER: world.loader };
  const processes = new SessionProcessSupervisor();
  const portRegistry = new PortRegistry();
  if (!disk) disk = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(disk.sql, disk.ctx);
  const fm = new FacetManager(ctx, env, processes, portRegistry, processHostFor, {
    notify: (line) => lines.push(line),
    // The same composition the session's ensureFacetManager makes: the
    // image-store default a self-owned durable launch re-drives through.
    resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(vfs, recipe),
    ...hooks,
  });
  fm.setVfs(vfs);
  return { boots, lines, world, ctx, env, fm, processes, portRegistry, storage, vfs, disk };
}

// ── 1. the store is content-addressed and kernel-only ────────────────────────
{
  const disk = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(disk.sql, disk.ctx);
  const image = await persistDurableWorkerImage(vfs, 'export default { fetch() {} }', {
    modules: { 'extra.js': 'export const x = 1;' },
    env: { TOKEN: 'abc' },
  });
  const kernel = vfs.as(CRED_KERNEL);
  assert.match(image.runner, /^[0-9a-f]{64}$/, 'the runner digest is a real sha256');
  assert.match(image.application, /^[0-9a-f]{64}$/, 'the application digest is a real sha256');
  assert.equal(
    kernel.readFileString(`${DURABLE_IMAGE_DIR}/${image.runner}`),
    'export default { fetch() {} }',
    'the runner blob round-trips by digest',
  );
  const payload = JSON.parse(kernel.readFileString(`${DURABLE_IMAGE_DIR}/${image.application}`));
  assert.equal(payload.modules['extra.js'], 'export const x = 1;', 'the application blob carries modules');
  assert.equal(payload.env.TOKEN, 'abc', 'the application blob carries env');

  // A second persist of the same inputs rewrites nothing: the digests name
  // the same bytes, so the store is idempotent across a relaunch.
  const again = await persistDurableWorkerImage(vfs, 'export default { fetch() {} }', {
    modules: { 'extra.js': 'export const x = 1;' },
    env: { TOKEN: 'abc' },
  });
  assert.deepEqual(again, image, 'identical inputs mint identical digests');

  // The resolver hands a re-drive its modules and env back; a missing row
  // reads as 'the application is gone', never an error a boot cannot answer.
  const resolved = await resolveDurableWorkerImage(vfs, { image });
  assert.equal(resolved.env.TOKEN, 'abc', 'the resolver restores env');
  assert.equal(resolved.modules['worker.js'], 'export default { fetch() {} }');
  assert.equal(resolved.modules['extra.js'], 'export const x = 1;');
  assert.equal(resolved.globalOutbound, undefined, 'the store never carries a binding');
  assert.equal(
    await resolveDurableWorkerImage(vfs, { image: { runner: '0'.repeat(64), application: '1'.repeat(64) } }),
    null,
    'a missing image resolves to absent, not an error',
  );
}

// ── 2. a self-owned durable spawn persists its image and re-drives after a
//      reset through the fallback resolver ───────────────────────────────────
{
  const { fm, ctx, storage, world, vfs, disk } = setup();
  await fm.spawnWorker('export default { start() {} }', 'self-owned durable', '/app', {
    env: { MARKER: 'img-env' },
    modules: { 'lib.js': 'export const v = 7;' },
    durable: { owner: 'self' },
  });
  const rows = [...storage.entries()].filter(([k]) => k.startsWith('resident-launch:'));
  assert.equal(rows.length, 1, 'the durable spawn journalled one launch');
  const recipe = rows[0][1].recipe;
  assert.equal(recipe.kind, 'worker');
  assert.match(recipe.image.runner, /^[0-9a-f]{64}$/, 'the journal names a real runner digest');
  const kernel = vfs.as(CRED_KERNEL);
  assert.equal(
    kernel.readFileString(`${DURABLE_IMAGE_DIR}/${recipe.image.runner}`),
    'export default { start() {} }',
    'the spawn persisted the runner blob it journalled',
  );
  const payload = JSON.parse(kernel.readFileString(`${DURABLE_IMAGE_DIR}/${recipe.image.application}`));
  assert.equal(payload.env.MARKER, 'img-env', 'the spawn persisted env into the image');

  // The platform reset: the facet is lost, the object is new, the storage
  // and the VFS the image lives on are the same ones.
  world.lose('app-slot-0');
  const before = world.boots.length;
  // A reset replaces the whole object: the successor's fresh process table
  // starts a generation higher, so the journalled pid is a previous one.
  const next = setup({ storage, world, disk });
  next.processes.setPidBase(PID_GEN_STRIDE);
  await runColdStart(next.ctx);
  await Promise.all(next.ctx.waited);

  assert.equal(world.boots.length, before + 1, 'the reset re-drove exactly one launch');
  const reboot = world.boots[world.boots.length - 1];
  assert.equal(reboot.facetName, 'app-slot-0', 'the re-drive re-attached the durable facet');
  assert.equal(
    reboot.config.env?.MARKER, 'img-env',
    'the fallback resolver restored env from the image',
  );
  assert.equal(
    reboot.config.modules['lib.js'], 'export const v = 7;',
    'the fallback resolver restored the application modules',
  );
  assert.equal(
    reboot.config.globalOutbound, undefined,
    'the restored launch carries no outbound binding',
  );
}

// ── 3. an embedder's resolver overrides the image-store fallback ─────────────
{
  const { fm, ctx, storage, world, disk } = setup();
  await fm.spawnWorker('export default {}', 'embedder-owned', '/app', {
    env: { FROM: 'image' },
    durable: { owner: 'E', image: { runner: 'r-e', application: 'app-e' } },
  });
  world.lose('app-slot-0');
  const before = world.boots.length;
  const embedderCalls = [];
  const next = setup({
    storage, world, disk,
    hooks: {
      resolveWorkerLaunch: async (recipe) => {
        embedderCalls.push(recipe.image);
        return {
          env: { FROM: 'embedder' },
          modules: { 'worker.js': 'export default { embedder: true }' },
        };
      },
      resolveWorkerLaunchFallback: async () => {
        throw new Error('the fallback must not run when the embedder hook exists');
      },
    },
  });
  next.processes.setPidBase(PID_GEN_STRIDE);
  await runColdStart(next.ctx);
  await Promise.all(next.ctx.waited);

  assert.equal(world.boots.length, before + 1, 'the reset re-drove the embedder launch');
  assert.deepEqual(embedderCalls, [{ runner: 'r-e', application: 'app-e' }],
    'the embedder hook was asked with the journalled digests');
  const reboot = world.boots[world.boots.length - 1];
  assert.equal(reboot.config.env?.FROM, 'embedder',
    'the embedder answer won over the image store');
}

// ── 4. a durable spawn carrying globalOutbound is refused without an
//      embedder hook — and admitted under one ────────────────────────────────
{
  const outbound = { fetch: async () => new Response('mediated') };

  const noHook = setup();
  await assert.rejects(
    () => noHook.fm.spawnWorker('export default {}', 'outbound', '/app', {
      globalOutbound: outbound,
      durable: { owner: 'X' },
    }),
    /globalOutbound.*resolveWorkerLaunch|resolveWorkerLaunch.*globalOutbound/i,
    'a durable spawn cannot journal a live binding under the image-store fallback',
  );
  const rows = [...noHook.storage.keys()].filter((k) => k.startsWith('resident-launch:'));
  assert.equal(rows.length, 0, 'the refused spawn never journalled a launch');

  const withHook = setup({
    hooks: {
      resolveWorkerLaunch: async () => null,
    },
  });
  const spawned = await withHook.fm.spawnWorker('export default {}', 'outbound', '/app', {
    globalOutbound: outbound,
    durable: { owner: 'X', image: { runner: 'r-x', application: 'app-x' } },
  });
  assert.ok(spawned.pid > 0, 'the embedder hook admits a binding it can re-mint');
}

console.log('ok - durable image store (digests real, fallback re-drive restores env, embedder overrides, outbound refused)');
