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
 *   - the manager's esbuild, when the host shares none: its transforms run
 *     in a loader-backed facet that owns the esbuild wasm heap, because that
 *     heap is never released and the host's isolate is memory-constrained.
 *     It needs `env.LOADER`, `env.ASSETS` and `ctx.facets` and nothing of
 *     any host, so it is the factory's default rather than every host's copy.
 *   - `resolveWorkerLaunchFallback`: the durable image-store resolver a
 *     self-owned worker launch (the session's python/ruby residents, or an
 *     embedder spawn that let the manager persist its image) re-drives
 *     from. It needs only the filesystem. An embedder that keeps its own
 *     content store answers `resolveWorkerLaunch` and this is never reached
 *     for its recipes (see `WorkerRecipe.resident`).
 */

import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { NimbusFilesystemAuthority } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { createPortCapability, type PortEntry } from '@nimbus-sh/core/runtime/port-registry.js';
import { FacetManager, type FacetManagerHooks, type WorkerRecipe } from './manager.js';
import { processHostFor } from '../loaders/process-host.js';
import { resolveDurableWorkerImage } from './durable-images.js';
import {
  persistPortCapability,
  readPortReservation,
  readPortReservationByOwner,
  reservePort,
  routeCapabilityPort,
  type PortVisibility,
} from '../session/port-capability.js';
import { bindPublicPortCapability } from '../router/public-directory.js';
import { supervisorEsbuildService } from './esbuild-transform.js';

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
  /** The session's one authority — the manager never constructs a second. */
  filesystem: NimbusFilesystemAuthority;
  /**
   * A host's esbuild, shared with the manager. Absent: one whose transforms
   * run in the loader-backed transform facet, never in this isolate.
   */
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
  /**
   * The durable-application verbs a host answers for its embedder — the
   * session answers the same four through its `_rpc*` surface. Each is a
   * short composition of the exported port-capability primitives
   * (`@nimbus-sh/worker/port-capability`) and the manager's own methods, so
   * an embedder that wants a different composition has every piece; what is
   * NOT here is what only the session has (dev-server restore, HMR sockets,
   * the self-refreshing "starting" page).
   */
  apps: {
    /**
     * Reserve (or re-answer) the port `owner` holds, minting the capability
     * its URL is built on — minted here, stored on the reservation, so a URL
     * handed out before the application has ever booted is the one its
     * eventual binding re-adopts, and the one a reset re-adopts again.
     */
    ensureDurableApp(input: {
      owner: string;
      preferredPort?: number;
      visibility?: PortVisibility;
      name?: string;
    }): Promise<{ port: number; capability: string | null; visibility: PortVisibility }>;
    /**
     * End a durable application's contract: every launch the owner claims is
     * killed, its journal rows purged, its port released and its durable slot
     * freed. `port` is the address that was held; `removed` is false only
     * when no durable application held that owner at all.
     */
    removeDurableApp(owner: string): Promise<{ owner: string; removed: boolean; port: number | null }>;
    /**
     * Every registered port with its live capability, persisted at the
     * moment the embedder is told it — a capability nobody has been handed
     * does not need to survive anything.
     */
    listPorts(): Promise<Array<{ port: number; pid: number; registeredAt: number; capability: string }>>;
    /**
     * Route a request carrying a port capability to the process on `port`:
     * a durable application a reset left dead is re-driven first
     * (`manager.ensureDurableAppOnPort`), the persisted capability is
     * re-adopted, and a wrong capability is a 404 — never a 403, which would
     * confirm the port is listening. 503 with `Retry-After` while a re-drive
     * is mid-launch; 502 when nothing serves the port. WebSocket upgrades
     * keep fetch semantics through the registered facet.
     */
    routeCapabilityPort(port: number, capability: string, request: Request, innerPath: string): Promise<Response>;
  };
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
    resolveWorkerLaunchFallback: (recipe: WorkerRecipe) => resolveDurableWorkerImage(vfs, recipe),
  };
  const manager = new FacetManager(ctx, env, deps.processes, deps.portRegistry, processHostFor, hooks);
  manager.setVfs(vfs, deps.filesystem);
  manager.setEsbuildService(deps.esbuild ?? supervisorEsbuildService(ctx, env, vfs.as(CRED_KERNEL)));
  const { portRegistry } = deps;
  const capabilityHost = { ctx, portRegistry };
  return {
    manager,
    pumpLaunches: () => manager.pumpResidentLaunches(),
    apps: {
      async ensureDurableApp(input) {
        if (typeof input.owner !== 'string' || input.owner.length === 0) {
          throw new Error('ensureDurableApp: owner must be a non-empty string');
        }
        const occupied = new Set(portRegistry.getAll().map((entry) => entry.port));
        const port = await reservePort(ctx, {
          owner: input.owner,
          preferredPort: input.preferredPort,
          occupiedPorts: occupied,
          capability: createPortCapability(),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
        });
        const record = await readPortReservation(ctx, port);
        if (record?.visibility === 'public' && record.capability !== null) {
          // A no-op for a host whose Durable Object is not a session (the
          // public directory keys on the session name); loud when it is a
          // session without the binding.
          await bindPublicPortCapability({ env, ctx }, record.capability, port, input.name);
        }
        return {
          port,
          capability: record?.capability ?? null,
          visibility: record?.visibility ?? 'scoped',
        };
      },
      async removeDurableApp(owner) {
        if (typeof owner !== 'string' || owner.length === 0) {
          throw new Error('removeDurableApp: owner must be a non-empty string');
        }
        const held = await readPortReservationByOwner(ctx, owner);
        const removed = await manager.removeDurableApp(owner);
        return { owner, removed, port: held?.port ?? null };
      },
      async listPorts() {
        const entries: PortEntry[] = portRegistry.getAll();
        await Promise.all(entries.map((entry) => persistPortCapability(capabilityHost, entry.port, entry.capability)));
        return entries.map((entry) => ({
          port: Number(entry.port),
          pid: Number(entry.pid),
          registeredAt: Number(entry.registeredAt),
          capability: String(entry.capability),
        }));
      },
      routeCapabilityPort(port, capability, request, innerPath) {
        // The session's routeToSessionPort is the one implementation —
        // the capability gate AND the public-bearer visibility gate live
        // there; a copy here dropped the latter. Session-only concerns
        // (dev-server restore, the vite-shim branch) no-op on this host.
        return routeCapabilityPort(
          { ctx, portRegistry, ensureDurableAppOnPort: (p: number) => manager.ensureDurableAppOnPort(p) },
          port, capability, request, innerPath,
        );
      },
    },
  };
}
