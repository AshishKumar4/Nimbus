/**
 * The workerd {@link FacetHost}: a facet is a dynamic worker.
 *
 * The whole adapter is the option rename below, because `NimbusLoaderPool`
 * already IS the port's shape — `submit` and `dispose`, with the same meanings.
 * The one thing it spells differently is the supervisor capability, which it
 * takes as a pid plus a separate flag saying whether to bind one at all; the
 * port collapses the pair, since a facet with the binding and no pid can read
 * the session and never write to it.
 */
import type { Facet, FacetHost, FacetSpec } from '@nimbus-sh/core/runtime/facet-host.js';
import type { FacetManager } from '../facets/manager.js';
import { NimbusLoaderPool } from '../loaders/loader-pool.js';

export function loaderFacetHost(env: unknown, ctx: DurableObjectState): FacetHost {
  return {
    open(spec: FacetSpec): Facet {
      return new NimbusLoaderPool(env, ctx, {
        tag: spec.tag,
        concurrency: spec.concurrency,
        preamble: spec.preamble,
        wasmModules: spec.wasmModules,
        omitSupervisor: spec.supervisorPid === undefined,
        supervisorPid: spec.supervisorPid,
      });
    },
  };
}

/**
 * The two objects a NimbusLoaderPool needs from a FacetManager.
 *
 * FacetManager does not expose its `env` and `ctx` in its type, but a loader
 * pool is constructed from exactly those, so every runtime that spawns facets
 * needs the same reach-through. Reflect.get rather than a cast: the shape is
 * checked here once, and a FacetManager built on something other than a
 * DurableObjectState fails with a sentence instead of at the first RPC.
 */
export function getFacetManagerLoaderHost(
  facetMgr: FacetManager,
): { env: unknown; ctx: DurableObjectState } {
  const env = Reflect.get(facetMgr, 'env');
  const ctx = Reflect.get(facetMgr, 'ctx');
  if (!isDurableObjectState(ctx)) {
    throw new Error('a loader-backed runtime requires a FacetManager with DurableObjectState context');
  }
  return { env, ctx };
}

/** The facet host a runtime reached through a FacetManager runs on. */
export function facetHostForManager(facetMgr: FacetManager): FacetHost {
  const { env, ctx } = getFacetManagerLoaderHost(facetMgr);
  return loaderFacetHost(env, ctx);
}

function isDurableObjectState(value: unknown): value is DurableObjectState {
  if (typeof value !== 'object' || value === null) return false;
  return 'id' in value && typeof Reflect.get(value, 'waitUntil') === 'function';
}
