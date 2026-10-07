/**
 * helper-facet.ts — a Durable Object's loader-backed helper facets: the
 * transform facet (Oxc), the esbuild facet and the build facet (rolldown).
 * Each is one child actor whose worker owns an engine's wasm, so the
 * object's own isolate never instantiates it.
 */
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
    const worker = await loader.get(spec.id, () => spec.code({ ASSETS: assets }));
    const facetClass = worker.getDurableObjectClass(spec.className);
    return ctx.facets.get(spec.id, async () => ({ class: facetClass }));
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
