/**
 * helper-facet.ts — a Durable Object's loader-backed helper facets: the
 * transform facet (Oxc), the esbuild facet and the build facet (rolldown).
 * Each is one child actor whose worker owns an engine's wasm, so the
 * object's own isolate never instantiates it.
 */

import type { DurableObject } from 'cloudflare:workers';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
import type { StagedSourceEnv } from '../runtime/staged-source.js';

/** What a helper facet is: its worker id and facet name, its class, and its code, built from the staged assets. */
export interface HelperFacetSpec {
  id: string;
  className: string;
  /** How a missing binding names it: "the transform facet". */
  what: string;
  code(assets: Required<StagedSourceEnv>): Promise<WorkerCode>;
}

/**
 * Load a helper facet: the worker `spec.id` from `env.LOADER`, its code
 * built from `env.ASSETS` the first time, and its class as the child facet
 * named `spec.id`. Needs `env.LOADER`, `env.ASSETS` and `ctx.facets`, and
 * nothing of any host.
 */
export async function loadHelperFacet<T extends DurableObject>(
  ctx: DurableObjectState,
  env: unknown,
  spec: HelperFacetSpec,
): Promise<Fetcher<T>> {
  const loader = Reflect.get(Object(env), 'LOADER');
  if (!loader || typeof loader.get !== 'function') throw new Error(`Nimbus: env.LOADER unavailable for ${spec.what}`);
  const assets = Reflect.get(Object(env), 'ASSETS');
  if (!assets || typeof assets.fetch !== 'function') throw new Error(`Nimbus: env.ASSETS unavailable for ${spec.what}`);
  const worker = await loader.get(spec.id, () => spec.code({ ASSETS: assets }));
  const facetClass = worker.getDurableObjectClass(spec.className);
  return ctx.facets.get<T>(spec.id, async () => ({ class: facetClass }));
}

/**
 * One stub per Durable Object: a caller that starts while another is still
 * loading the facet waits on that load. A load or call that failed drops the
 * entry; the next caller loads a fresh stub.
 */
export class SharedHelperFacet<T extends DurableObject> {
  readonly #stubs = new WeakMap<DurableObjectState, Promise<Fetcher<T>>>();

  constructor(private readonly spec: HelperFacetSpec) {}

  stub(ctx: DurableObjectState, env: unknown): Promise<Fetcher<T>> {
    const current = this.#stubs.get(ctx);
    if (current) return current;
    const loaded = loadHelperFacet<T>(ctx, env, this.spec);
    this.#stubs.set(ctx, loaded);
    loaded.catch(() => this.forget(ctx, loaded));
    return loaded;
  }

  /** Drop `stub`, a stub that threw and may be broken for good, unless a newer one replaced it. */
  forget(ctx: DurableObjectState, stub: Promise<Fetcher<T>>): void {
    if (this.#stubs.get(ctx) === stub) this.#stubs.delete(ctx);
  }
}
