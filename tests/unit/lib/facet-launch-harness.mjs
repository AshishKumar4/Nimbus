// A session's FacetManager as the session DO builds one, for the resident
// launch tests: a facet world evaluating the test's program, the world's
// LOADER and the staged ASSETS, a process table and port registry, and the
// session's filesystem. Which SUPERVISOR double the world binds is each
// test's (adoptCtxExports): what it asserts against differs.

import { FacetManager } from '../../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../../packages/core/src/runtime/port-registry.ts';
import { PID_GEN_STRIDE } from '../../../packages/core/src/runtime/process-table.ts';
import { SessionProcessSupervisor } from '../../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { createFacetCtx, createFacetWorld } from '../facet-host-harness.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { processFiles } from './process-bridge.mjs';
import { stagedAssets } from './staged-assets.mjs';

/** A program that starts and answers every request 'ok'. */
export const idleProgram = () => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
});

/**
 * One session's durable half: its storage rows and its filesystem, which
 * every instance of the session shares across a reset.
 */
export function launchSession({ disk = createSqliteVfsTestHarness() } = {}) {
  return { storage: new Map(), vfs: new SqliteVFS(disk.sql, disk.ctx), disk };
}

/**
 * An instance of `session` named `label`. `generation` sets its pid base
 * (an instance after a reset allocates past the last one's pids); `env`
 * adds bindings beside LOADER and ASSETS; `hooks` are the manager's;
 * `crashable` is the facet ctx's (its storage writes can be lost).
 */
export function launchManager(label, {
  evaluate = idleProgram, session = launchSession(), env = {}, hooks = {}, generation,
  processes = new SessionProcessSupervisor(), ports = new PortRegistry(), crashable = false,
} = {}) {
  const world = createFacetWorld(evaluate);
  if (generation !== undefined) processes.setPidBase(generation * PID_GEN_STRIDE);
  const ctx = createFacetCtx(world, label, session.storage, { crashable });
  const manager = new FacetManager(
    ctx, { LOADER: world.loader, ASSETS: stagedAssets, ...env }, processes, ports, processHostFor, hooks,
  );
  manager.setVfs(session.vfs, processFiles(session.vfs));
  return { world, ctx, processes, ports, manager, vfs: session.vfs };
}
