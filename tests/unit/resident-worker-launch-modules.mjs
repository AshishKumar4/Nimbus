#!/usr/bin/env bun
// A worker launch carries an embedder's module shape and returns its facet.
//
// `spawnWorker` used to hardcode `worker.js` as the main module, accept
// inline `modules` and by-path `vfsWasmModules` only, and answer `{ pid,
// boot }` — so an embedder whose program is a runner plus content-addressed
// text modules, invoked directly rather than through a port, could not
// launch through it at all. This pins the launch shape end to end, on the
// same facet host the resident-launch tests run on:
//
//   1. `vfsTextModules` land in the boot spec under their module names, read
//      through the kernel image path and verified against their digest;
//   2. `mainModule` is honoured — the isolate boots from it and `workerCode`
//      is placed under that name;
//   3. the returned facet routes a request to the process's own handle;
//   4. a journalled launch re-drives after an instance reset with the same
//      modules, text modules and main module.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { facetImageDigest, facetImagePath } from '../../packages/fabric/src/process-fabric.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const env = (world) => ({
  LOADER: world.loader,
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
    },
  },
});

/**
 * The program the facet world evaluates: it reports the module map it was
 * booted with, and its request handler echoes which main module it is.
 */
const evaluate = (config, { facetName }) => ({
  async startProcess() { return { ok: true, facetName, mainModule: config.mainModule }; },
  async handleHttpRequest(request) {
    return Response.json({ facetName, mainModule: config.mainModule, url: request.url });
  },
});

/** One session's durable half: storage rows and filesystem, shared across instances. */
function createSession() {
  const storage = new Map();
  const disk = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(disk.sql, disk.ctx);
  return { storage, vfs };
}

/** One instance of the session over `session`, at pid generation `generation`. */
function createInstance(session, generation, label) {
  const world = createFacetWorld(evaluate);
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(generation * PID_GEN_STRIDE);
  const ctx = createFacetCtx(world, label, session.storage);
  const notices = [];
  const manager = new FacetManager(ctx, env(world), processes, new PortRegistry(), processHostFor, {
    notify: (line) => { notices.push(line); },
    resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(session.vfs, recipe),
  });
  manager.setVfs(session.vfs);
  return { ctx, world, processes, manager, notices };
}

/** Write a content-addressed text module the way an embedder's store would. */
async function putTextModule(vfs, source) {
  const path = facetImagePath(await facetImageDigest(source));
  const fs = vfs.as(CRED_KERNEL);
  const dir = path.slice(1, path.lastIndexOf('/'));
  fs.mkdir(dir, { recursive: true, mode: 0o755 });
  fs.writeFile(path.slice(1), source, { mode: 0o644 });
  return path;
}

const RUNNER = 'import { answer } from "./lib.js"; export default { fetch: () => new Response(answer) };';
const LIB = 'export const answer = "forty-two";';
const HELPER = 'export const helper = true;';

// ── 1 + 2 + 3: text modules, main module, and the returned facet ──────────
{
  const session = createSession();
  const gen1 = createInstance(session, 1, 'modules-gen1');
  const libPath = await putTextModule(session.vfs, LIB);

  const spawned = await gen1.manager.spawnWorker(RUNNER, 'embedder app', '/home/user', {
    mainModule: 'runner.js',
    modules: { 'helper.js': HELPER },
    vfsTextModules: { 'lib.js': libPath },
  });

  assert.ok(spawned.pid > PID_GEN_STRIDE, 'a pid of this generation');
  assert.deepEqual(spawned.boot, { ok: true, facetName: spawned.boot.facetName, mainModule: 'runner.js' }, 'the boot payload is the runner\'s');
  assert.equal(gen1.world.configs.size, 1, 'one module map was built');
  const [config] = [...gen1.world.configs.values()];
  assert.equal(config.mainModule, 'runner.js', 'the isolate boots from the named main module');
  assert.equal(config.modules['runner.js'], RUNNER, 'and workerCode sits under that name');
  assert.equal(config.modules['helper.js'], HELPER, 'inline modules ride by value');
  assert.equal(config.modules['lib.js'], LIB, 'the text module landed under its module name, read by path');
  assert.equal(Object.hasOwn(config.modules, 'worker.js'), false, 'no worker.js was invented');

  assert.equal(typeof spawned.facet.fetch, 'function');
  assert.equal(typeof spawned.facet.connect, 'function');
  assert.equal(Object.hasOwn(spawned.facet, 'release'), false, 'the facet owns no lifecycle — kill(pid) does');
  const answered = await spawned.facet.fetch(new Request('http://worker.local/hello?x=1'));
  assert.equal(answered.status, 200);
  const body = await answered.json();
  assert.equal(body.mainModule, 'runner.js', 'the facet routed to the process that booted from runner.js');
  assert.equal(body.url, 'http://worker.local/hello?x=1', 'the request reached the handle intact');
  assert.equal(body.facetName, spawned.boot.facetName, 'and it is the same facet the boot ran in');

  // The main module cannot also be an inline module: workerCode IS the main module.
  await assert.rejects(
    gen1.manager.spawnWorker(RUNNER, 'clash', '/home/user', { mainModule: 'runner.js', modules: { 'runner.js': 'x' } }),
    /main module 'runner\.js' is also an inline module/,
  );

  // A bad text module path is refused by the loader, not booted as garbage.
  await assert.rejects(
    gen1.manager.spawnWorker(RUNNER, 'bad path', '/home/user', {
      mainModule: 'runner.js', vfsTextModules: { 'lib.js': '/home/user/not-content-addressed.js' },
    }),
    /not a content-addressed facet image path/,
  );

  gen1.manager.kill(spawned.pid);
}

// ── 4: a journalled launch re-drives with the same shape ──────────────────
{
  const session = createSession();
  const libPath = await putTextModule(session.vfs, LIB);

  const gen1 = createInstance(session, 1, 'redrive');
  const spawned = await gen1.manager.spawnWorker(RUNNER, 'durable app', '/home/user', {
    mainModule: 'runner.js',
    modules: { 'helper.js': HELPER },
    vfsTextModules: { 'lib.js': libPath },
    durable: { owner: 'app:one' },
  });
  const row = session.storage.get('resident-launch:' + spawned.pid);
  assert.ok(row, 'the durable launch is journalled');
  assert.equal(row.recipe.kind, 'worker');
  assert.equal(row.recipe.mainModule, 'runner.js', 'the recipe records the main module');
  assert.equal(row.recipe.resident, undefined, 'an embedder worker is not an interpreter resident');
  const [first] = [...gen1.world.configs.values()];

  // The instance is lost with the process still running; the replacement
  // reads the row it left and re-drives the launch from the image store.
  const gen2 = createInstance(session, 2, 'redrive');
  await gen2.manager.pumpResidentLaunches();
  for (let i = 0; i < 400 && gen2.world.configs.size === 0; i++) await new Promise((r) => setTimeout(r, 5));

  assert.equal(gen2.notices.length, 1, 'the user is told once');
  assert.match(gen2.notices[0], /restarted while "durable app" was running — restarting it/);
  assert.equal(gen2.world.configs.size, 1, 'the re-driven launch built its module map and booted');
  const [second] = [...gen2.world.configs.values()];
  assert.equal(second.mainModule, first.mainModule, 'the same main module');
  assert.deepEqual(second.modules, first.modules, 'the same modules — inline and text alike');
  assert.equal(second.modules['runner.js'], RUNNER);
  assert.equal(second.modules['lib.js'], LIB, 'the text module was restored by path from the journalled image');
  assert.equal(second.modules['helper.js'], HELPER);

  const rows = [...session.storage.keys()].filter((k) => k.startsWith('resident-launch:'));
  assert.equal(rows.length, 1, 'one row — the re-driven launch owns it now');
  const newPid = Number(rows[0].slice('resident-launch:'.length));
  assert.ok(newPid > 2 * PID_GEN_STRIDE, 'under a pid of the replacement generation');
  assert.equal(gen2.processes.get(newPid)?.state, 'running');
  gen2.manager.kill(newPid);
}

console.log('PASS resident-worker-launch-modules');
