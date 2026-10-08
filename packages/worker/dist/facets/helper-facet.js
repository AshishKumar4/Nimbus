/**
 * helper-facet.ts — a Durable Object's loader-backed helper facets: the
 * transform facet (Oxc), the esbuild facet and the build facet (rolldown).
 * Each is one child actor whose worker owns an engine's wasm, so the
 * object's own isolate never instantiates it.
 */
import { applyFacetLimits, facetCallDeadlineMs, facetLimits, facetLoaderKey } from '@nimbus-sh/fabric/facet-limits.js';
/**
 * Load a helper facet: the worker `spec.id` from `env.LOADER`, its code
 * built from `env.ASSETS` the first time, and its class as the child facet
 * named `spec.id`. Needs `env.LOADER`, `env.ASSETS` and `ctx.facets`, and
 * nothing of any host.
 */
export async function loadHelperFacet(ctx, env, spec) {
    const loader = Reflect.get(Object(env), 'LOADER');
    if (!loader || typeof loader.get !== 'function')
        throw new Error(`Nimbus: env.LOADER unavailable for ${spec.what}`);
    const assets = Reflect.get(Object(env), 'ASSETS');
    if (!assets || typeof assets.fetch !== 'function')
        throw new Error(`Nimbus: env.ASSETS unavailable for ${spec.what}`);
    const kind = spec.kind ?? 'worker';
    const worker = await loader.get(facetLoaderKey(kind, spec.id), async () => applyFacetLimits(kind, await spec.code({ ASSETS: assets })));
    const facetClass = worker.getDurableObjectClass(spec.className, { limits: facetLimits(kind) });
    return boundedCalls(ctx.facets.get(spec.id, async () => ({ class: facetClass })), spec, kind);
}
/**
 * `stub`, with each compute call bounded by `kind`'s call deadline
 * (facetCallDeadlineMs): one that has not answered by then fails, naming the
 * facet, the method and the deadline. The call is released, not retried; the
 * caller drops the stub as it does after any failed call. A process method
 * (spec.processMethods) runs unbounded, as every process does. The one place
 * a helper facet's calls are bounded, so no call site keeps its own timer.
 */
function boundedCalls(stub, spec, kind) {
    const deadlineMs = facetCallDeadlineMs(kind);
    if (deadlineMs === undefined)
        return stub;
    const processMethods = new Set(spec.processMethods ?? []);
    return new Proxy(stub, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== 'function')
                return value;
            // Called on the stub itself, never on this wrapper (Symbol.dispose included).
            if (typeof property !== 'string' || processMethods.has(property))
                return value.bind(target);
            return (...args) => withinDeadline(Promise.resolve(Reflect.apply(value, target, args)), deadlineMs, `Nimbus: ${spec.what}'s ${property} gave no answer within ${deadlineMs} ms (the ${kind} kind's call deadline)`);
        },
    });
}
/** `call`, or a rejection with `message` once `ms` pass first. */
async function withinDeadline(call, ms, message) {
    let timer = null;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
    try {
        return await Promise.race([call, expired]);
    }
    finally {
        if (timer !== null)
            clearTimeout(timer);
    }
}
/**
 * One stub per Durable Object: a caller that starts while another is still
 * loading the facet waits on that load. A load or call that failed drops the
 * entry; the next caller loads a fresh stub.
 */
export class SharedHelperFacet {
    spec;
    #stubs = new WeakMap();
    constructor(spec) {
        this.spec = spec;
    }
    stub(ctx, env) {
        const current = this.#stubs.get(ctx);
        if (current)
            return current;
        const loaded = loadHelperFacet(ctx, env, this.spec);
        this.#stubs.set(ctx, loaded);
        loaded.catch(() => this.forget(ctx, loaded));
        return loaded;
    }
    /** Drop `stub`, a stub that threw and may be broken for good, unless a newer one replaced it. */
    forget(ctx, stub) {
        if (this.#stubs.get(ctx) === stub)
            this.#stubs.delete(ctx);
    }
}
