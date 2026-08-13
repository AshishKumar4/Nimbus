/**
 * facet-host.ts — where a program carrying compiled WebAssembly actually runs.
 *
 * Every WASM runtime Nimbus ships (bash, CPython, Ruby, clang, the generic
 * `wasm-runner`) has the same shape: a self-contained scheduler shipped as
 * SOURCE, a table of wasm modules that must be compiled before the scheduler
 * can reach them, and a function submitted into that scope with plain data and
 * back. Only the substrate underneath differs.
 *
 * On workerd that substrate is a dynamic worker: request-time
 * `WebAssembly.instantiate(bytes)` is refused by CSP, so the bytes ride inside
 * the loader's modules map and are compiled during the inner worker's
 * module-load phase — the one phase where wasm code generation is permitted.
 * Off workerd there is no such rule and the same scope is built in place
 * ({@link ./local-facet-host.ts}).
 *
 * NOT named after either. `Facet` is what Nimbus has always called this — one
 * program, its own module scope, its own wasm table — and the port is the
 * whole of what a runtime needs from it, so a runner cannot tell which
 * substrate answered and never asks.
 */

/**
 * A function submitted into a facet.
 *
 * It is SERIALIZED on any host that runs it elsewhere, so it must be
 * self-contained: closure references do not survive the crossing, and neither
 * do module imports. Names the spec's `preamble` declares ARE in scope — that
 * is what the preamble is for — and everything else travels as `args`.
 *
 * `bindings` carries whatever capabilities the host minted for this facet;
 * `SUPERVISOR` is the session syscall capability, present only when the spec
 * named a pid to act as.
 */
export type FacetFn<A, R> = (args: A, bindings: FacetBindings) => R | Promise<R>;

/** Capabilities handed to the facet's function as its second argument. */
export interface FacetBindings {
  /** The session's syscall capability, bound to {@link FacetSpec.supervisorPid}. */
  readonly SUPERVISOR?: unknown;
}

export interface FacetSpec {
  /** Names the facet in diagnostics and in the host's own reuse key. */
  tag: string;
  /**
   * Source evaluated once, before any function is submitted, in the scope those
   * functions are evaluated in. This is how a runtime's scheduler and its WASI
   * layer get there: they are far too large to travel per call, and they hold
   * the state a session needs between calls (bash's process tree, CPython's
   * `__main__`).
   */
  preamble?: string;
  /**
   * Wasm images the facet's scope exposes as compiled `WebAssembly.Module`s on
   * `globalThis.__NIMBUS_WASM[<key>]`. Compiled by the host, because on workerd
   * the caller is not allowed to.
   */
  wasmModules?: Record<string, ArrayBuffer>;
  /**
   * Pid the facet's `SUPERVISOR` capability acts as, or absent for a facet
   * that makes no syscalls back into the session.
   *
   * Not a boolean and not optional-with-a-default: the supervisor derives the
   * WRITE credential from this pid, so a facet given the capability without a
   * pid can read the filesystem it was seeded with and silently write nowhere.
   * Making the pid the only way to ask for it removes that state.
   */
  supervisorPid?: number;
  /** Facets the host may keep warm for this spec. Default 1. */
  concurrency?: number;
}

export interface FacetSubmitOptions {
  /**
   * Deadline for this call, honoured by hosts that can abandon a facet.
   *
   * A host sharing the caller's thread cannot: a wasm guest in a synchronous
   * loop holds the only thread there is, and nothing observes a timer until it
   * yields. Such a host says so ({@link ./local-facet-host.ts}) rather than
   * racing a timer and returning while the guest runs on.
   */
  timeoutMs?: number;
  /** Wasm images for this call alone, merged over {@link FacetSpec.wasmModules}. */
  wasmModules?: Record<string, ArrayBuffer>;
}

/**
 * One facet's scope, for as long as a runtime needs it.
 *
 * Held rather than per-call because the scope IS the session: bash boots on the
 * first submit and is fed on every one after, and a scope rebuilt between them
 * would hand the second call a shell that had never run.
 */
export interface Facet {
  submit<A, R>(fn: FacetFn<A, R>, args: A, options?: FacetSubmitOptions): Promise<Awaited<R>>;
  /** Idempotent. The scope and everything it holds are dropped. */
  dispose(): void;
}

export interface FacetHost {
  open(spec: FacetSpec): Facet;
}
