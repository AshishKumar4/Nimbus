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

import type {
  Facet,
  FacetBindings,
  FacetFn,
  FacetHost,
  FacetSpec,
  FacetSubmitOptions,
} from './facet-host.js';
import { manifestVfs } from './vfs-manifest.js';
import { vfsSupervisor } from './vfs-supervisor.js';

/** A submitted function after it has been re-created inside the facet's scope. */
type ScopedFacetFn = (args: unknown, bindings: FacetBindings) => unknown;

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
const AsyncFunction = Object.getPrototypeOf(async (): Promise<void> => {}).constructor as
  new (...args: string[]) => (this: object, ...args: unknown[]) => Promise<unknown>;

type WasmCompiler = (bytes: BufferSource) => Promise<WebAssembly.Module>;

/**
 * The standard `WebAssembly.compile`, checked for rather than assumed.
 *
 * `@cloudflare/workers-types` declares no compiler and an abstract `Module`,
 * which is not an oversight: workerd forbids compiling at request time, and
 * that prohibition is the entire reason facets exist. Core is typed against
 * that surface, so the one host that DOES compile asks for the capability by
 * name and says so plainly when it is absent.
 */
function wasmCompiler(): WasmCompiler {
  const compile: unknown = Reflect.get(WebAssembly, 'compile');
  if (typeof compile !== 'function') {
    throw new Error(
      'Nimbus: this host cannot compile WebAssembly in place (no WebAssembly.compile), '
      + 'so it needs a facet host with its own isolates rather than this one',
    );
  }
  return compile as WasmCompiler;
}

/**
 * Run facets in this isolate.
 *
 * `parking: 'none'` is the whole character of this host, and everything else
 * follows from it: the guest is entered on an ordinary stack, so no syscall may
 * suspend it, so the supervisor it mints is the authority's synchronous view
 * and every syscall is answered on the guest's own stack.
 *
 * The one thing a substrate with its own isolates gives that this cannot:
 * {@link FacetSubmitOptions.timeoutMs} is not honoured. A guest spinning
 * synchronously holds the only thread, so no timer fires until it is already
 * finished; racing one would return while the program ran on.
 */
export function localFacetHost(): FacetHost {
  return {
    parking: 'none',
    /**
     * A manifest walked exhaustively, so CPython's thousands of startup probes
     * for absent paths are answered from it; everything it names is served by
     * the authority's synchronous view, since a guest on an ordinary stack
     * cannot park on a promise.
     */
    seedFilesystem(vfs, root, options) {
      return manifestVfs(vfs, options.cred, root, options);
    },
    open: (spec) => new LocalFacet(spec),
  };
}

class LocalFacet implements Facet {
  /** Evaluates a source string in the preamble's own scope. Built on first use. */
  private evaluate: ((source: string) => unknown) | null = null;
  private readonly wasmTable: Record<string, WebAssembly.Module> = {};
  /** Keyed by the bytes themselves: the same image is compiled once per facet. */
  private readonly modules = new WeakMap<ArrayBuffer, WebAssembly.Module>();
  private readonly scoped = new Map<FacetFn<never, unknown>, ScopedFacetFn>();
  /** Submits are serialized: one scope, and a facet's calls are ordered. */
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  private readonly bindings: FacetBindings;

  constructor(private readonly spec: FacetSpec) {
    this.bindings = spec.syscalls
      ? { SUPERVISOR: vfsSupervisor(spec.syscalls.vfs) }
      : {};
  }

  submit<A, R>(fn: FacetFn<A, R>, args: A, options?: FacetSubmitOptions): Promise<Awaited<R>> {
    const run = this.queue.then(() => this.call(fn, args, options));
    // The chain must survive a rejected call, or one failure poisons the facet.
    this.queue = run.catch(() => undefined);
    return run as Promise<Awaited<R>>;
  }

  private async call<A, R>(fn: FacetFn<A, R>, args: A, options?: FacetSubmitOptions): Promise<R> {
    if (this.disposed) throw new Error(`Nimbus: facet '${this.spec.tag}' is disposed`);
    const scope = await this.scope(options?.wasmModules);
    let scoped = this.scoped.get(fn as FacetFn<never, unknown>);
    if (!scoped) {
      const value = scope(`(${fn.toString()})`);
      if (typeof value !== 'function') {
        throw new Error(`Nimbus: facet '${this.spec.tag}' was submitted a value that is not a function`);
      }
      scoped = value as ScopedFacetFn;
      this.scoped.set(fn as FacetFn<never, unknown>, scoped);
    }
    return await scoped(args, this.bindings) as R;
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
  private async scope(
    callModules: Record<string, ArrayBuffer> | undefined,
  ): Promise<(source: string) => unknown> {
    const built = this.evaluate;
    if (!built) await this.addModules(this.spec.wasmModules);
    await this.addModules(callModules);
    if (built) return built;
    const globals = { __NIMBUS_WASM: this.wasmTable };
    const build = new AsyncFunction(
      'globalThis',
      `${this.spec.preamble ?? ''}\nreturn (source) => eval(source);`,
    );
    const evaluate = await build.call(globals, globals) as (source: string) => unknown;
    this.evaluate = evaluate;
    return evaluate;
  }

  private async addModules(modules: Record<string, ArrayBuffer> | undefined): Promise<void> {
    for (const [name, bytes] of Object.entries(modules ?? {})) {
      let module = this.modules.get(bytes);
      if (!module) {
        module = await wasmCompiler()(bytes);
        this.modules.set(bytes, module);
      }
      this.wasmTable[name] = module;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.evaluate = null;
    this.scoped.clear();
    for (const name of Object.keys(this.wasmTable)) delete this.wasmTable[name];
  }
}
