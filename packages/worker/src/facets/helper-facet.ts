/**
 * helper-facet.ts — a Durable Object's loader-backed helper facets: the
 * transform facet (Oxc), the esbuild facet and the build facet (rolldown).
 * Each is one child actor whose worker owns an engine's wasm, so the
 * object's own isolate never instantiates it.
 */

import type { DurableObject } from 'cloudflare:workers';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
import { applyFacetLimits, facetCallDeadlineMs, facetLimits, facetLoaderKey, type FacetKind } from '@nimbus-sh/fabric/facet-limits.js';
import type { StagedSourceEnv } from '../runtime/staged-source.js';

/** What a helper facet is: its worker id and facet name, its class, and its code, built from the staged assets. */
export interface HelperFacetSpec {
  kind?: FacetKind;
  id: string;
  className: string;
  /** How a missing binding names it: "the transform facet". */
  what: string;
  /**
   * The facet's methods that run a process (the esbuild CLI): they have no
   * wall deadline. Every other method is a compute call, bounded by the
   * kind's call deadline (boundedCalls).
   */
  processMethods?: readonly string[];
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
  const kind = spec.kind ?? 'worker';
  const worker = await loader.get(facetLoaderKey(kind, spec.id), async () => applyFacetLimits(kind, await spec.code({ ASSETS: assets })));
  const facetClass = worker.getDurableObjectClass(spec.className, { limits: facetLimits(kind) });
  return boundedCalls(ctx.facets.get<T>(spec.id, async () => ({ class: facetClass })), spec, kind);
}

/**
 * `stub`, with each compute call bounded by `kind`'s call deadline
 * (facetCallDeadlineMs): one that has not answered by then fails, naming the
 * facet, the method and the deadline. The call is released, not retried; the
 * caller drops the stub as it does after any failed call. A process method
 * (spec.processMethods) runs unbounded, as every process does. The one place
 * a helper facet's calls are bounded, so no call site keeps its own timer.
 */
function boundedCalls<T extends DurableObject>(stub: Fetcher<T>, spec: HelperFacetSpec, kind: FacetKind): Fetcher<T> {
  const deadlineMs = facetCallDeadlineMs(kind);
  if (deadlineMs === undefined) return stub;
  const processMethods = new Set(spec.processMethods ?? []);
  return new Proxy(stub, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      // Called on the stub itself, never on this wrapper (Symbol.dispose included).
      if (typeof property !== 'string' || processMethods.has(property)) return value.bind(target);
      return (...args: unknown[]) => withinDeadline(
        Promise.resolve(Reflect.apply(value, target, args)),
        deadlineMs,
        `Nimbus: ${spec.what}'s ${property} gave no answer within ${deadlineMs} ms (the ${kind} kind's call deadline)`,
      );
    },
  });
}

/** `call`, or a rejection with `message` once `ms` pass first. */
async function withinDeadline<R>(call: Promise<R>, ms: number, message: string): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  try {
    return await Promise.race([call, expired]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
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
