/**
 * The two objects a NimbusLoaderPool needs from a FacetManager.
 *
 * FacetManager does not expose its `env` and `ctx` in its type, but a loader
 * pool is constructed from exactly those, so every runtime that spawns facets
 * needs the same reach-through. Reflect.get rather than a cast: the shape is
 * checked here once, and a FacetManager built on something other than a
 * DurableObjectState fails with a sentence instead of at the first RPC.
 */
import type { FacetManager } from '../facets/manager.js';

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

function isDurableObjectState(value: unknown): value is DurableObjectState {
  if (typeof value !== 'object' || value === null) return false;
  return 'id' in value && typeof Reflect.get(value, 'waitUntil') === 'function';
}
