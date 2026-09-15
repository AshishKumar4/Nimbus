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
import { createPortCapability } from '@nimbus-sh/core/runtime/port-registry.js';
import { FacetManager } from './manager.js';
import { processHostFor } from '../loaders/process-host.js';
import { resolveDurableWorkerImage } from './durable-images.js';
import { persistPortCapability, readPortReservation, readPortReservationByOwner, reservePort, } from '../session/port-capability.js';
import { bindPublicPortCapability } from '../router/public-directory.js';
import { routeCapabilityPort } from '../session/routes.js';
import { ESBUILD_TRANSFORM_WORKER_ID, esbuildTransformWorkerCode, } from './esbuild-transform.js';
import { fetchEsbuildWasmBytes } from '../runtime/esbuild-wasm-bytes.js';
export { FacetManager, DEFAULT_WORKER_MAIN_MODULE } from './manager.js';
/**
 * Compose a FacetManager over a host's own ctx, env, process supervisor, port
 * registry and filesystem. See the module comment for what is defaulted.
 */
export function composeFacetManager(deps) {
    const { ctx, env, vfs } = deps;
    const hooks = {
        onExternalExit: deps.hooks.onExternalExit,
        notify: deps.hooks.notify,
        requestLaunchTurn: deps.hooks.requestLaunchTurn,
        ...(deps.hooks.onSpawn !== undefined ? { onSpawn: deps.hooks.onSpawn } : {}),
        ...(deps.hooks.resolveWorkerLaunch !== undefined
            ? { resolveWorkerLaunch: deps.hooks.resolveWorkerLaunch }
            : {}),
        transformLargeEsm: isolatedEsmTransform(ctx, env),
        resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(vfs, recipe),
    };
    const manager = new FacetManager(ctx, env, deps.processes, deps.portRegistry, processHostFor, hooks);
    manager.setVfs(vfs);
    if (deps.esbuild)
        manager.setEsbuildService(deps.esbuild);
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
                const entries = portRegistry.getAll();
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
                return routeCapabilityPort({ ctx, portRegistry, ensureDurableAppOnPort: (p) => manager.ensureDurableAppOnPort(p) }, port, capability, request, innerPath);
            },
        },
    };
}
/**
 * The isolated esbuild transform: module text past the in-isolate bound is
 * transformed in a loader-backed facet that owns the esbuild wasm heap, so the
 * host isolate never pays for it. Session-independent by construction —
 * `env.LOADER`, `env.ASSETS` and `ctx.facets` are all it reads.
 */
function isolatedEsmTransform(ctx, env) {
    return async (code, options) => {
        const loader = Reflect.get(Object(env), 'LOADER');
        if (!loader || typeof loader.get !== 'function') {
            throw new Error('Nimbus: env.LOADER unavailable for isolated esbuild transform');
        }
        const assets = Reflect.get(Object(env), 'ASSETS');
        if (!assets || typeof assets.fetch !== 'function') {
            throw new Error('Nimbus: env.ASSETS unavailable for isolated esbuild transform');
        }
        const worker = await loader.get(ESBUILD_TRANSFORM_WORKER_ID, async () => esbuildTransformWorkerCode(await fetchEsbuildWasmBytes({ ASSETS: assets })));
        const transformClass = worker.getDurableObjectClass('EsbuildTransformFacet');
        const facet = ctx.facets.get(`esbuild-transform-${ESBUILD_TRANSFORM_WORKER_ID}`, async () => ({ class: transformClass }));
        return facet.transform(code, options);
    };
}
