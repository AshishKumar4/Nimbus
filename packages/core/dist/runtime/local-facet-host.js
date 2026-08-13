/**
 * local-facet-host.ts — a facet that runs in the caller's own isolate.
 *
 * The {@link FacetHost} for every embedder that is not workerd. There is no
 * dynamic-worker substrate to reach for and no CSP forbidding a compile, so the
 * scope a facet needs is built where it is asked for: compile the wasm table,
 * evaluate the preamble once, and evaluate each submitted function inside it.
 *
 * The function is still SERIALIZED rather than called in place, and that is the
 * point rather than an accident of symmetry. A runner's facet function reads
 * names the preamble declares — `__wasiMakeImports`, `__bashBoot` — which exist
 * only in the scope the preamble was evaluated in; calling the original closure
 * would resolve them against this module instead and fail. Serializing also
 * keeps the contract honest: a closure reference that would break on workerd
 * breaks here too, in a unit test, rather than in production.
 *
 * `globalThis` inside a facet is the facet's own scope object, not the process
 * global. Preambles publish their entry points on it and runners read them back
 * from it, so two facets in one process must not see each other's — and the
 * process must not see either.
 */
/**
 * The standard `WebAssembly.compile`, checked for rather than assumed.
 *
 * `@cloudflare/workers-types` declares no compiler and an abstract `Module`,
 * which is not an oversight: workerd forbids compiling at request time, and
 * that prohibition is the entire reason facets exist. Core is typed against
 * that surface, so the one host that DOES compile asks for the capability by
 * name and says so plainly when it is absent.
 */
function wasmCompiler() {
    const compile = Reflect.get(WebAssembly, 'compile');
    if (typeof compile !== 'function') {
        throw new Error('Nimbus: this host cannot compile WebAssembly in place (no WebAssembly.compile), '
            + 'so it needs a facet host with its own isolates rather than this one');
    }
    return compile;
}
/**
 * Run facets in this isolate.
 *
 * Two things a substrate with its own isolates gives for free are not here, and
 * a caller that needs them needs a different host:
 *
 *   - {@link FacetSubmitOptions.timeoutMs} is not honoured. A guest spinning
 *     synchronously holds the only thread, so no timer fires until it is
 *     already finished; racing one would return while the program ran on.
 *   - {@link FacetSpec.supervisorPid} is refused. The capability it names is a
 *     write credential over the session, and a facet handed the seed without it
 *     reads a filesystem it can never write to — silently. Refusing is the only
 *     answer that cannot be mistaken for working.
 */
export function localFacetHost() {
    return { open: (spec) => new LocalFacet(spec) };
}
class LocalFacet {
    spec;
    /** Evaluates a source string in the preamble's own scope. Built on first use. */
    evaluate = null;
    wasmTable = {};
    /** Keyed by the bytes themselves: the same image is compiled once per facet. */
    modules = new WeakMap();
    scoped = new Map();
    /** Submits are serialized: one scope, and a facet's calls are ordered. */
    queue = Promise.resolve();
    disposed = false;
    constructor(spec) {
        this.spec = spec;
        if (spec.supervisorPid !== undefined) {
            throw new Error(`Nimbus: facet '${spec.tag}' asks for a supervisor capability bound to pid `
                + `${spec.supervisorPid}, which a facet running in the caller's own isolate cannot mint`);
        }
    }
    submit(fn, args, options) {
        const run = this.queue.then(() => this.call(fn, args, options));
        // The chain must survive a rejected call, or one failure poisons the facet.
        this.queue = run.catch(() => undefined);
        return run;
    }
    async call(fn, args, options) {
        if (this.disposed)
            throw new Error(`Nimbus: facet '${this.spec.tag}' is disposed`);
        const scope = await this.scope();
        await this.addModules(options?.wasmModules);
        let scoped = this.scoped.get(fn);
        if (!scoped) {
            const value = scope(`(${fn.toString()})`);
            if (typeof value !== 'function') {
                throw new Error(`Nimbus: facet '${this.spec.tag}' was submitted a value that is not a function`);
            }
            scoped = value;
            this.scoped.set(fn, scoped);
        }
        return await scoped(args, {});
    }
    /**
     * The facet's scope, built once.
     *
     * The returned closure's `eval` is a DIRECT eval inside the body the preamble
     * was evaluated in, which is what puts the preamble's top-level declarations
     * in scope for every function submitted afterwards.
     */
    async scope() {
        if (this.evaluate)
            return this.evaluate;
        await this.addModules(this.spec.wasmModules);
        const globals = { __NIMBUS_WASM: this.wasmTable };
        const build = new Function('globalThis', `${this.spec.preamble ?? ''}\nreturn (source) => eval(source);`);
        this.evaluate = build.call(globals, globals);
        return this.evaluate;
    }
    async addModules(modules) {
        for (const [name, bytes] of Object.entries(modules ?? {})) {
            let module = this.modules.get(bytes);
            if (!module) {
                module = await wasmCompiler()(bytes);
                this.modules.set(bytes, module);
            }
            this.wasmTable[name] = module;
        }
    }
    dispose() {
        this.disposed = true;
        this.evaluate = null;
        this.scoped.clear();
        for (const name of Object.keys(this.wasmTable))
            delete this.wasmTable[name];
    }
}
