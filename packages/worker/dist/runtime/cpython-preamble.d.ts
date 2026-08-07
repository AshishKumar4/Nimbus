/**
 * cpython-preamble.ts — the guest half of the CPython runtime, as source.
 *
 * This text is spliced into a loader child's module scope, after the WASI host
 * from runtime/wasi/preamble.ts and the virtual socket kernel. It owns exactly
 * one thing: turning a compiled python.wasm into a running interpreter and
 * feeding it source. Everything about WHAT to run belongs to cpython-runner.ts.
 *
 * Three constraints shape it, all of them learned the expensive way:
 *
 *   1. Every entry into the VM goes through `enterVm`, which is
 *      WebAssembly.promising. Not just the calls known to park today — V8 traps
 *      ANY call into a WebAssembly.Suspending import from a stack that
 *      promising did not enter, including one that returns a plain integer.
 *      Which imports the interpreter reaches is the interpreter's business and
 *      the suspending set grows.
 *
 *   2. __wasiInitFS deliberately clears the adopted supervisor, so the
 *      supervisor is adopted AFTER it, never before. The other order leaves the
 *      guest reading a filesystem it can never write back to, which looks like
 *      success right up until the writes are gone.
 *
 *   3. The interpreter is compiled once, in the child-init window where
 *      compilation is allowed, and instantiated per call. Instantiation is not
 *      gated; only compilation is. A fresh instance per one-shot invocation is
 *      also what makes each `python -c` a pristine interpreter rather than one
 *      carrying the last caller's __main__.
 */
/** Marker the runner writes around the interpreter's exit status. */
export declare const CPYTHON_EXIT_MARKER = "__NIMBUS_PY_EXIT__";
export declare const CPYTHON_PREAMBLE_TAIL: string;
//# sourceMappingURL=cpython-preamble.d.ts.map