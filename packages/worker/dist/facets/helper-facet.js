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
    const facetName = spec.facetName ?? spec.id;
    const stub = ctx.facets.get(facetName, async () => ({ class: facetClass }));
    return spec.runsProcesses ? stub : boundedCalls(ctx, facetName, stub, spec, kind);
}
/**
 * A helper facet's compute call that outlived its kind's call deadline. Not
 * retried: the same input would wait as long again (buildFacetPrebundler and
 * oxcTransformHost let it through as it is).
 */
export class FacetCallDeadlineError extends Error {
    what;
    method;
    kind;
    deadlineMs;
    constructor(what, method, kind, deadlineMs) {
        super(`Nimbus: ${what}'s ${method} gave no answer within ${deadlineMs} ms (the ${kind} kind's call deadline)`);
        this.what = what;
        this.method = method;
        this.kind = kind;
        this.deadlineMs = deadlineMs;
        this.name = 'FacetCallDeadlineError';
    }
}
/**
 * `stub`, with each compute call bounded by `kind`'s call deadline
 * (facetCallDeadlineMs). The one place a helper facet's calls are bounded,
 * so no call site keeps its own timer.
 *
 * A call that has not answered by then is ended, not abandoned: an RPC
 * cannot be cancelled by itself, so the facet is aborted, which ends its
 * work and every call on it (a late plugin answer has nothing to resume),
 * and the next load gets a fresh actor. Only then does the call fail, with a
 * FacetCallDeadlineError, so the caller's admission is released after the
 * work really ended. A facet that runs processes is a separate actor
 * (spec.runsProcesses), so this never ends a running esbuild command.
 */
function boundedCalls(ctx, facetName, stub, spec, kind) {
    const deadlineMs = facetCallDeadlineMs(kind);
    if (deadlineMs === undefined)
        return stub;
    return new Proxy(stub, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== 'function')
                return value;
            // Called on the stub itself, never on this wrapper (Symbol.dispose included).
            if (typeof property !== 'string')
                return value.bind(target);
            return (...args) => withinDeadline(Promise.resolve(Reflect.apply(value, target, args)), deadlineMs, () => {
                const expired = new FacetCallDeadlineError(spec.what, property, kind, deadlineMs);
                try {
                    ctx.facets.abort(facetName, expired);
                }
                catch { /* already gone */ }
                return expired;
            });
        },
    });
}
/** `call`, or, once `ms` pass first, a rejection with what `expire` returns (after it has run). */
async function withinDeadline(call, ms, expire) {
    let timer = null;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(expire()), ms); });
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
