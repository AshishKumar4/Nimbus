/**
 * facets/compose.ts — the one composition of a FacetManager.
 *
 * A FacetManager is the session's spawn path for every resident process —
 * `spawnWorker`, `spawnNode`, the launch journal, `_redrive`, cold-start
 * recovery and the paced launch pump — and until this module it was
 * constructed in exactly one place, inside NimbusSession, with hooks that
 * closed over the session. An embedder that composes NimbusWorkspace as a
 * library over its own Durable Object has no session and must not boot one
 * over its filesystem (a second process table hands out pids whose write
 * authority the filesystem already revoked), so everything behind the
 * manager was closed to it.
 *
 * `composeFacetManager` is that construction, taking exactly what an
 * embedder can supply: the Durable Object's ctx and env, its process
 * supervisor, port registry and SQLite filesystem, an optional shared
 * esbuild service, and the hooks a host has to answer. NimbusSession's own
 * `ensureFacetManager` calls this same factory — there is one path — and
 * keeps only what is session-specific (terminal writes, scrollback notices,
 * the alarm that grants launch turns) inside its hook implementations.
 *
 * What the factory owns and the host does not:
 *
 *   - `transformLargeEsm`: the isolated esbuild transform for module text
 *     past the in-isolate size bound. It needs `env.LOADER`, `env.ASSETS`
 *     and `ctx.facets` and nothing of any host, so it is the factory's
 *     default rather than every host's copy.
 *   - `resolveWorkerLaunchFallback`: the durable image-store resolver a
 *     self-owned worker launch (the session's python/ruby residents, or an
 *     embedder spawn that let the manager persist its image) re-drives
 *     from. It needs only the filesystem. An embedder that keeps its own
 *     content store answers `resolveWorkerLaunch` and this is never reached
 *     for its recipes (see `WorkerRecipe.resident`).
 */

import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { FacetManager, type FacetManagerHooks, type WorkerRecipe } from './manager.js';
import { processHostFor } from '../loaders/process-host.js';
import { resolveDurableWorkerImage } from './durable-images.js';
import {
  ESBUILD_TRANSFORM_WORKER_ID,
  esbuildTransformWorkerCode,
  type EsbuildTransformFacetRpc,
} from './esbuild-transform.js';
import { fetchEsbuildWasmBytes } from '../runtime/esbuild-wasm-bytes.js';

export type {
  FacetManagerHooks,
  LongRunningWorkerSpawnOptions,
  ResidentSpawnOptions,
  ResolvedWorkerLaunch,
  ResidentAppSummary,
  ResidentIdentity,
  ResidentRestartPolicy,
  SpawnedWorker,
  WorkerFacet,
  WorkerRecipe,
} from './manager.js';
export { FacetManager, DEFAULT_WORKER_MAIN_MODULE } from './manager.js';

/**
 * The hooks a host answers. Names and types are the FacetManager's own
 * (`FacetManagerHooks`); the three a host cannot do without are required
 * here because a manager composed without them loses launches silently —
 * a launch turn nobody grants never resumes, an exit nobody hears leaves a
 * process table lying, a notice nobody shows is a reset the user never
 * learns about.
 */
export interface FacetManagerHostHooks {
  onExternalExit: NonNullable<FacetManagerHooks['onExternalExit']>;
  notify: NonNullable<FacetManagerHooks['notify']>;
  requestLaunchTurn: NonNullable<FacetManagerHooks['requestLaunchTurn']>;
  onSpawn?: FacetManagerHooks['onSpawn'];
  resolveWorkerLaunch?: FacetManagerHooks['resolveWorkerLaunch'];
}

/** Everything a FacetManager is composed over. */
export interface FacetManagerDeps {
  ctx: DurableObjectState;
  /** The Worker's bindings: `LOADER` is required, `ASSETS` serves the esbuild wasm. */
  env: unknown;
  processes: SessionProcessSupervisor;
  portRegistry: PortRegistry;
  vfs: SqliteVFS;
  /** A host's already-warm esbuild, shared so the wasm is initialized once. */
  esbuild?: EsbuildService;
  hooks: FacetManagerHostHooks;
}

/** What `composeFacetManager` hands back. */
export interface ComposedFacetManager {
  manager: FacetManager;
  /**
   * The paced launch pump — the manager's own `pumpResidentLaunches`, not a
   * second one. The host drives it from the turn `hooks.requestLaunchTurn`
   * arranged (the session: its `'resident-launch'` alarm); the first pump on
   * a fresh incarnation also drains cold-start recovery of the launch
   * journal (fabric's `FencedWork.recoverInterrupted`, registered on the
   * manager's `onColdStart`), so it is the cold-start recovery entry too:
   * the session calls it once from initSession for exactly that reason.
   */
  pumpLaunches: () => Promise<void>;
}

/**
 * Compose a FacetManager over a host's own ctx, env, process supervisor, port
 * registry and filesystem. See the module comment for what is defaulted.
 */
export function composeFacetManager(deps: FacetManagerDeps): ComposedFacetManager {
  const { ctx, env, vfs } = deps;
  const hooks: FacetManagerHooks = {
    onExternalExit: deps.hooks.onExternalExit,
    notify: deps.hooks.notify,
    requestLaunchTurn: deps.hooks.requestLaunchTurn,
    ...(deps.hooks.onSpawn !== undefined ? { onSpawn: deps.hooks.onSpawn } : {}),
    ...(deps.hooks.resolveWorkerLaunch !== undefined
      ? { resolveWorkerLaunch: deps.hooks.resolveWorkerLaunch }
      : {}),
    transformLargeEsm: isolatedEsmTransform(ctx, env),
    resolveWorkerLaunchFallback: (recipe: WorkerRecipe) => resolveDurableWorkerImage(vfs, recipe),
  };
  const manager = new FacetManager(ctx, env, deps.processes, deps.portRegistry, processHostFor, hooks);
  manager.setVfs(vfs);
  if (deps.esbuild) manager.setEsbuildService(deps.esbuild);
  return {
    manager,
    pumpLaunches: () => manager.pumpResidentLaunches(),
  };
}

/**
 * The isolated esbuild transform: module text past the in-isolate bound is
 * transformed in a loader-backed facet that owns the esbuild wasm heap, so the
 * host isolate never pays for it. Session-independent by construction —
 * `env.LOADER`, `env.ASSETS` and `ctx.facets` are all it reads.
 */
function isolatedEsmTransform(
  ctx: DurableObjectState,
  env: unknown,
): NonNullable<FacetManagerHooks['transformLargeEsm']> {
  return async (code, options) => {
    const loader = Reflect.get(Object(env), 'LOADER');
    if (!loader || typeof loader.get !== 'function') {
      throw new Error('Nimbus: env.LOADER unavailable for isolated esbuild transform');
    }
    const assets = Reflect.get(Object(env), 'ASSETS');
    if (!assets || typeof assets.fetch !== 'function') {
      throw new Error('Nimbus: env.ASSETS unavailable for isolated esbuild transform');
    }
    const worker = await loader.get(ESBUILD_TRANSFORM_WORKER_ID, async () =>
      esbuildTransformWorkerCode(await fetchEsbuildWasmBytes({ ASSETS: assets })),
    );
    const transformClass = worker.getDurableObjectClass('EsbuildTransformFacet');
    const facet = ctx.facets.get<EsbuildTransformFacetRpc>(
      `esbuild-transform-${ESBUILD_TRANSFORM_WORKER_ID}`,
      async () => ({ class: transformClass }),
    );
    return facet.transform(code, options);
  };
}
