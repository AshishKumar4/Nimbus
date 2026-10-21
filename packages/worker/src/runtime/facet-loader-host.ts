/**
 * The workerd {@link FacetHost}: a facet is a dynamic worker.
 *
 * The whole adapter is the option renames below, because `IsolatePool`
 * already IS the port's shape — `submit` and `dispose`, with the same meanings.
 * The one thing it spells differently is the supervisor capability, which it
 * takes as a pid plus a separate flag saying whether to bind one at all; the
 * port collapses the pair, since a facet with the binding and no pid can read
 * the session and never write to it. `reuse` is the pool's `cacheScope` under
 * the name the port gives it: who a warm facet may answer for; `warm` is its
 * `scope`, with the capability handed per call. The one thing
 * the host binds rather than renames is the network: every facet it opens goes
 * out through the workspace's (its egress, when it has one), so no runtime
 * opening a facet can leave it out.
 */
import { networkRef, requireNetwork, type WorkspaceNetwork, type WorkspaceNetworkRef } from '@nimbus-sh/core/_shared/workspace-network.js';
import type { Facet, FacetHost, FacetImage, FacetSpec, FacetSubmitOptions } from '@nimbus-sh/core/runtime/facet-host.js';
import type { FacetTaskSource } from '@nimbus-sh/core/runtime/facet-task.js';
import type { SupervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import { warmFacetScope } from '@nimbus-sh/core/runtime/warm-facets.js';
import type { FacetManager } from '../facets/manager.js';
import { IsolatePool } from '@nimbus-sh/fabric/isolate-pool.js';
import { supervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import { holdThreadWatch } from '@nimbus-sh/fabric/thread-stalls.js';

/**
 * The transforms and builds a host's own Durable Object runs outside the
 * session, composed the way the supervisor's are: transforms in the object's
 * transform facet (Nimbus's Oxc build), builds in its build facet
 * (rolldown), never in its isolate, where an engine's wasm memory would only
 * grow.
 */
export { supervisorEsbuildService } from '../facets/esbuild-transform.js';

// Experiment (D1, not for landing): a session's one-shots of these runtimes run
// on another session Durable Object (by name, set per session from the probe
// app), its own IsolatePool over the same spec, its syscalls routed back here.
// On globalThis: the probe app's copy of this module is not the SDK's.
export function d1OneShotPeer(): Map<string, string> {
  const shared = globalThis as unknown as { __nimbusD1OneShotPeer?: Map<string, string> };
  return shared.__nimbusD1OneShotPeer ??= new Map();
}
const D1_MOVED = /^(tsrs|clang-runner|cpython-runner|ruby-runner|git-runner)/;
export interface D1PeerImage { path: string; identity: string; size: number; peak: number; stream(): Promise<ReadableStream<Uint8Array>> }
export interface D1PeerShape {
  key: string; origin: string; tag: string; preamble?: string; concurrency?: number;
  wasmModules?: Record<string, D1PeerImage>; supervisorPid?: number; processSupervisor?: SupervisorBindingProps;
  reuse?: 'session' | 'global'; scope?: string; supervisorPerCall: boolean; network?: WorkspaceNetworkRef;
}
interface D1Peer {
  _rpcD1PeerSubmit(shape: D1PeerShape, fn: FacetTaskSource<unknown, unknown>, args: unknown, options: { timeoutMs?: number; wasmModules?: Record<string, D1PeerImage> }): Promise<unknown>;
  _rpcD1PeerDispose(key: string): Promise<void>;
}
function d1Images(images: Record<string, FacetImage> | undefined): Record<string, D1PeerImage> | undefined {
  if (images === undefined) return undefined;
  return Object.fromEntries(Object.entries(images).map(([name, image]) => [name, {
    path: image.path, identity: image.identity, size: image.size, peak: image.peak,
    stream: async () => new Blob([await image.read()]).stream(),
  }]));
}
function d1Peer(env: unknown, name: string): D1Peer {
  const sessions = (env as { NIMBUS_SESSION: DurableObjectNamespace }).NIMBUS_SESSION;
  return sessions.get(sessions.idFromName(name)) as unknown as D1Peer;
}

/**
 * Facets as dynamic workers over `env` and `ctx`, each going out through
 * `network`: the workspace's (`workspace.network`, or `workspaceNetwork(egress)`
 * for the egress the workspace is created with).
 */
export function loaderFacetHost(env: unknown, ctx: DurableObjectState, network: WorkspaceNetwork): FacetHost {
  requireNetwork(network, 'loaderFacetHost');
  return {
    // workerd suspends a guest through JSPI, which is what lets a syscall reach
    // back to the session mid-instruction.
    parking: 'jspi',
    open(spec: FacetSpec): Facet {
      const processSupervisor = spec.syscalls ? supervisorBindingProps(ctx, spec.syscalls.pid, { writerId: crypto.randomUUID(), network }) : undefined;
      const pool = new IsolatePool(env, ctx, {
        tag: spec.tag,
        concurrency: spec.concurrency,
        preamble: spec.preamble,
        wasmModules: spec.wasmModules,
        omitSupervisor: spec.syscalls === undefined,
        supervisorPid: spec.syscalls?.pid,
        processSupervisor,
        cacheScope: spec.reuse,
        scope: spec.warm === undefined ? undefined : warmFacetScope(spec.warm),
        supervisorPerCall: spec.warm !== undefined,
        network,
      });
      // Experiment (D1, not for landing): the session's thread watched while a
      // one-shot runs; a moved runtime's call runs on the session's peer, when it names one.
      const shape: D1PeerShape = {
        key: crypto.randomUUID(), origin: ctx.id.toString(), tag: spec.tag, preamble: spec.preamble, concurrency: spec.concurrency,
        wasmModules: d1Images(spec.wasmModules), supervisorPid: spec.syscalls?.pid, processSupervisor,
        reuse: spec.reuse, scope: spec.warm === undefined ? undefined : warmFacetScope(spec.warm), supervisorPerCall: spec.warm !== undefined,
        network: networkRef(network),
      };
      let peerUsed: string | undefined;
      return {
        submit<A, R>(fn: FacetTaskSource<A, R>, args: A, options?: FacetSubmitOptions): Promise<Awaited<R>> {
          const watched = holdThreadWatch(ctx, `one-shot ${spec.tag}`);
          const peerName = D1_MOVED.test(spec.tag) ? d1OneShotPeer().get(ctx.id.toString()) : undefined;
          if (peerName === undefined) return pool.submit(fn, args, options).finally(watched);
          peerUsed = peerName;
          return (d1Peer(env, peerName)._rpcD1PeerSubmit(shape, fn as FacetTaskSource<unknown, unknown>, args,
            { timeoutMs: options?.timeoutMs, wasmModules: d1Images(options?.wasmModules) }) as Promise<Awaited<R>>).finally(watched);
        },
        dispose: () => {
          pool.dispose();
          if (peerUsed !== undefined) ctx.waitUntil(d1Peer(env, peerUsed)._rpcD1PeerDispose(shape.key).catch(() => {}));
        },
      };
    },
  };
}

/**
 * What an IsolatePool is built from, from a FacetManager: its env and ctx and
 * the workspace's network, via the manager's own `loaderHost()` accessor. The
 * runtime guard stays: harnesses build FacetManagers on mock contexts, and one
 * built on something other than a DurableObjectState should fail with a
 * sentence instead of at the first RPC.
 */
export function getFacetManagerLoaderHost(
  facetMgr: FacetManager,
): { env: unknown; ctx: DurableObjectState; network: WorkspaceNetwork } {
  const { env, ctx, network } = facetMgr.loaderHost();
  if (!isDurableObjectState(ctx)) {
    throw new Error('a loader-backed runtime requires a FacetManager with DurableObjectState context');
  }
  return { env, ctx, network };
}

/** The facet host a runtime reached through a FacetManager runs on, over the manager's network. */
export function facetHostForManager(facetMgr: FacetManager): FacetHost {
  const { env, ctx, network } = getFacetManagerLoaderHost(facetMgr);
  return loaderFacetHost(env, ctx, network);
}

function isDurableObjectState(value: unknown): value is DurableObjectState {
  if (typeof value !== 'object' || value === null) return false;
  return 'id' in value && typeof Reflect.get(value, 'waitUntil') === 'function';
}
