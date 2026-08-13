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
import { snapshotVfs } from './vfs-snapshot.js';
import { vfsSupervisor } from './vfs-supervisor.js';
/**
 * `new Function`, but for a body that may `await` at its top level.
 *
 * A facet preamble is written as a MODULE body, and the WASI shim uses that:
 * it resolves `cloudflare:sockets` with a top-level `await import(...)` inside a
 * try/catch, so a host that does not have the module gets a shim without
 * sockets instead of a shim that fails to parse. `new Function` cannot hold
 * that; an async function body can, and the rejected import lands in the same
 * catch it was written for.
 */
const AsyncFunction = Object.getPrototypeOf(async () => { }).constructor;
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
 * The bound on a complete seed: a limit on this process's own heap.
 *
 * Deliberately far above `snapshotVfs`'s 32 MiB default, which is a TRANSPORT
 * limit — the ceiling on one workerd RPC payload. Nothing is transported here,
 * so keeping that number would refuse a program over a filesystem the host is
 * already holding. Exceeding this is still an error rather than a truncation:
 * a seed that silently omitted a file would make it absent to the guest.
 */
const LOCAL_SEED_MAX_BYTES = 512 * 1024 * 1024;
const LOCAL_SEED_MAX_FILES = 200_000;
/**
 * Run facets in this isolate.
 *
 * `parking: 'none'` is the whole character of this host, and everything else
 * follows from it: the guest is entered on an ordinary stack, so no syscall may
 * suspend it, so {@link FacetHost.seedFilesystem} hands over the bytes rather
 * than a manifest to fetch them with, and the supervisor it mints serves only
 * the writes — which drain after the program returns, where a promise is free.
 *
 * The one thing a substrate with its own isolates gives that this cannot:
 * {@link FacetSubmitOptions.timeoutMs} is not honoured. A guest spinning
 * synchronously holds the only thread, so no timer fires until it is already
 * finished; racing one would return while the program ran on.
 */
export function localFacetHost() {
    return {
        parking: 'none',
        /**
         * By value, and exhaustively: no skip list, because a directory hidden
         * from the seed is a directory the guest cannot see at all — there is no
         * second chance to fetch it. That completeness is what
         * `snapshotVfs` records as `enumeratedRoots`, and it is what keeps CPython's
         * thousands of startup probes for absent paths from each trying to suspend.
         */
        seedFilesystem(vfs, root, options) {
            const seeded = snapshotVfs(vfs, root, {
                extraRoots: options?.extraRoots,
                skipSubdirs: [],
                maxBytes: LOCAL_SEED_MAX_BYTES,
                maxFiles: LOCAL_SEED_MAX_FILES,
            });
            if ('error' in seeded)
                return seeded;
            // The seed is also the WHOLE of what this guest has, which is a stronger
            // claim than the walk's: `snapshotVfs` reports the roots it listed
            // exhaustively, and this says every path outside them is absent too. It
            // is — a miss out there could only be answered by suspending the guest
            // mid-syscall, which this host cannot do, so the alternative to "absent"
            // is not "fetched" but a read the guest can never receive. Ruby's VM
            // startup stats dozens of prefixes it was never given.
            return { ...seeded, snapshot: { ...seeded.snapshot, enumeratedRoots: [''] } };
        },
        open: (spec) => new LocalFacet(spec),
    };
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
    bindings;
    constructor(spec) {
        this.spec = spec;
        this.bindings = spec.syscalls
            ? { SUPERVISOR: vfsSupervisor(spec.syscalls.vfs) }
            : {};
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
        const scope = await this.scope(options?.wasmModules);
        let scoped = this.scoped.get(fn);
        if (!scoped) {
            const value = scope(`(${fn.toString()})`);
            if (typeof value !== 'function') {
                throw new Error(`Nimbus: facet '${this.spec.tag}' was submitted a value that is not a function`);
            }
            scoped = value;
            this.scoped.set(fn, scoped);
        }
        return await scoped(args, this.bindings);
    }
    /**
     * The facet's scope, built once.
     *
     * The returned closure's `eval` is a DIRECT eval inside the body the preamble
     * was evaluated in, which is what puts the preamble's top-level declarations
     * in scope for every function submitted afterwards.
     *
     * Both wasm tables are filled BEFORE that body runs, per-call images merged
     * over the spec's. A preamble may boot its runtime as it is evaluated — Ruby
     * instantiates the interpreter right there — so it reads the table at that
     * moment and an image added afterwards would arrive to a facet that had
     * already given up on it. workerd has the same ordering for the same reason:
     * per-call images ride in the module map the inner worker is built from.
     */
    async scope(callModules) {
        const built = this.evaluate;
        if (!built)
            await this.addModules(this.spec.wasmModules);
        await this.addModules(callModules);
        if (built)
            return built;
        const globals = { __NIMBUS_WASM: this.wasmTable };
        const build = new AsyncFunction('globalThis', `${this.spec.preamble ?? ''}\nreturn (source) => eval(source);`);
        const evaluate = await build.call(globals, globals);
        this.evaluate = evaluate;
        return evaluate;
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
