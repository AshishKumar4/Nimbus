// A session's FacetManager as the session DO builds one, for the resident
// launch tests: a facet world evaluating the test's program, the world's
// LOADER and the staged ASSETS, a process table and port registry, and the
// session's filesystem. Which SUPERVISOR double the world binds is each
// test's (adoptCtxExports): what it asserts against differs.

import { FacetManager } from '../../../packages/worker/src/facets/manager.ts';
import { PortRegistry } from '../../../packages/core/src/runtime/port-registry.ts';
import { PID_GEN_STRIDE } from '../../../packages/core/src/runtime/process-table.ts';
import { SessionProcessSupervisor } from '../../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { atTestEnd, createFacetCtx, createFacetWorld, captureProcessBoots, residentRunner } from './facet-host-harness.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { processFiles } from './process-bridge.mjs';
import { stagedAssets } from './staged-assets.mjs';

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
 * `crashable` is the facet ctx's (its storage writes can be lost);
 * `evaluatesAdapter` is the facet world's (createFacetWorld); `evaluate` is
 * the program each facet runs, by default one that starts as the runner does
 * (residentRunner) and answers every request 'ok'.
 *
 * @param {string} label
 * @param {{ evaluate?: (config: object, meta: { died: Promise<never> }) => object, session?: ReturnType<typeof launchSession>, env?: object, hooks?: object,
 *   generation?: number, processes?: SessionProcessSupervisor, ports?: PortRegistry, crashable?: boolean,
 *   evaluatesAdapter?: boolean }} [options]
 */
export function launchManager(label, {
  evaluate, session = launchSession(), env = {}, hooks = {}, generation,
  processes = new SessionProcessSupervisor(), ports = new PortRegistry(), crashable = false, evaluatesAdapter = false,
} = {}) {
  // By default a program that starts and answers every request 'ok', keeping its start as the runner does.
  const world = createFacetWorld(evaluate ?? residentRunner(processes), { evaluatesAdapter });
  if (generation !== undefined) processes.setPidBase(generation * PID_GEN_STRIDE);
  const ctx = createFacetCtx(world, label, session.storage, { crashable });
  const manager = new FacetManager(
    ctx, { LOADER: world.loader, ASSETS: stagedAssets, ...env }, processes, ports, captureProcessBoots(world), hooks,
  );
  manager.setVfs(session.vfs, processFiles(session.vfs));
  // What the test leaves running ends with it, as a session's teardown ends its processes:
  // a resident would otherwise hold the file open until its timers fire (the uptime proof's 120 s).
  atTestEnd(() => { for (const entry of processes.getRunning()) processes.kill(entry.pid); });
  return { world, ctx, processes, ports, manager, vfs: session.vfs };
}
