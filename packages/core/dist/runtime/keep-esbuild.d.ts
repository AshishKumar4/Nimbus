/**
 * The esbuild a transform facet keeps between calls, and how one is started
 * so that its memory and its death can be read. Both functions are
 * self-contained: generateEsbuildFacetRuntimeSource serializes them into the
 * facet's module.
 */
/** esbuild as a transform facet drives it. */
export interface TransformEsbuild {
    transform(input: string, options?: object): Promise<unknown>;
    stop(): unknown;
}
/** esbuild's own API, as startObservedEsbuild starts it. */
export interface StartableEsbuild extends TransformEsbuild {
    initialize(options: {
        wasmModule: WebAssembly.Module;
        worker: boolean;
    }): Promise<void>;
}
/** An esbuild as keepEsbuild holds it. */
export interface KeptEsbuild<T> {
    esbuild: T;
    /** Its wasm linear memory, in bytes. */
    memoryBytes(): number;
    /** Whether it can serve no more calls: its Go program exited, or its wasm trapped. */
    closed(): boolean;
}
/**
 * Share an esbuild between calls. It is retired when a call leaves its wasm
 * memory past `highWaterBytes`, or leaves it closed, and stopped once its last
 * in-flight caller finishes; a failed start is forgotten. Stopping a wasm
 * instance does not eagerly free its memory: fresh instances per call leave
 * memory awaiting GC and multiply the live working set under parallel preview
 * requests. Go reuses freed heap, so reuse instead plateaus at the largest
 * working set (Pi's 23 slices reached 52 MiB shared, versus 153 MiB of
 * uncollected per-call instances, in V8).
 */
export declare function keepEsbuild<T extends {
    stop(): unknown;
}>(start: () => Promise<KeptEsbuild<T>>, highWaterBytes: number): <R>(use: (esbuild: T) => Promise<R>) => Promise<R>;
/**
 * Starts an esbuild whose wasm memory and death can be read. esbuild
 * instantiates its Go runtime itself; `newEsbuild` makes one that
 * instantiates through the WebAssembly namespace it is given, and this gives
 * it one whose `instantiate` notes the instance's exported `mem`, and wraps
 * Go's `runtime.wasmExit` import to see its program end. A transform pending
 * then would wait forever for its answer, so it fails, as does every later
 * one; after a wasm trap esbuild fails every call itself. Such failures carry
 * `transient: true`: they are no verdict on the source. Nothing global is
 * replaced.
 */
export declare function startObservedEsbuild(newEsbuild: (webAssembly: typeof WebAssembly) => StartableEsbuild, wasmModule: WebAssembly.Module): Promise<KeptEsbuild<TransformEsbuild>>;
//# sourceMappingURL=keep-esbuild.d.ts.map