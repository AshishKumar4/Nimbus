/**
 * The esbuild a transform facet keeps between calls, and how one is started
 * so that its memory and its death can be read. Both functions are
 * self-contained: generateEsbuildFacetRuntimeSource serializes them into the
 * facet's module.
 */

/** What a transform answers; the rest of esbuild's TransformResult is small. */
export interface TransformOutput {
  code: string;
  map: string;
}

/** esbuild as a transform facet drives it. */
export interface TransformEsbuild {
  transform(input: string, options?: object): Promise<TransformOutput>;
  stop(): unknown;
}

/** esbuild's own API, as startObservedEsbuild starts it. */
export interface StartableEsbuild extends TransformEsbuild {
  initialize(options: { wasmModule: WebAssembly.Module; worker: boolean }): Promise<void>;
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
export function keepEsbuild<T extends { stop(): unknown }>(
  start: () => Promise<KeptEsbuild<T>>,
  highWaterBytes: number,
): <R>(use: (esbuild: T) => Promise<R>) => Promise<R> {
  interface Kept { started: Promise<KeptEsbuild<T>>; users: number; retired: boolean }
  let current: Kept | null = null;
  return async <R>(use: (esbuild: T) => Promise<R>): Promise<R> => {
    if (current === null) {
      const fresh: Kept = { started: start(), users: 0, retired: false };
      current = fresh;
      fresh.started.catch(() => { if (current === fresh) current = null; });
    }
    const kept = current;
    kept.users++;
    let running: KeptEsbuild<T>;
    try {
      running = await kept.started;
    } catch (error) {
      kept.users--;
      throw error;
    }
    try {
      return await use(running.esbuild);
    } finally {
      kept.users--;
      if (!kept.retired && (running.closed() || running.memoryBytes() > highWaterBytes)) {
        kept.retired = true;
        if (current === kept) current = null;
      }
      if (kept.retired && kept.users === 0) {
        // The call's outcome stands whatever stopping does: a retired esbuild
        // is dropped either way.
        try {
          void Promise.resolve(running.esbuild.stop()).catch(() => {});
        } catch {
          // As above.
        }
      }
    }
  };
}

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
 *
 * The instance outlives many calls, so no call may stay reachable from it.
 * A pending call is held (to be failed if Go exits) only until it settles.
 * esbuild's adapter itself keeps every call's promise, and so its result,
 * reachable while the instance lives (each call subscribes to its
 * `rejectAllPromise`): 120 transforms of a 190 KiB module left 19.2 of their
 * 23.1 MiB of output on V8's heap, and 200 that failed on a 195 KiB module
 * left their inputs (73.2 MiB when the module was one line, which esbuild's
 * messages quote). So the caller gets a copy of a result, and a fresh error
 * for a failure, and what esbuild keeps is emptied: a result's code and map,
 * an error's stack and messages (keep-esbuild-heap.mjs).
 */
export async function startObservedEsbuild(
  newEsbuild: (webAssembly: typeof WebAssembly) => StartableEsbuild,
  wasmModule: WebAssembly.Module,
): Promise<KeptEsbuild<TransformEsbuild>> {
  let memory: unknown = null;
  let closed = false;
  const pending = new Set<(error: Error) => void>();
  const stopped = (): Error => Object.assign(new Error('esbuild stopped: its Go program exited'), { transient: true });
  const exit = (): void => {
    closed = true;
    for (const fail of pending) fail(stopped());
    pending.clear();
  };
  const observed = Object.create(WebAssembly, {
    instantiate: {
      value: async (module: WebAssembly.Module, imports: WebAssembly.Imports) => {
        const gojs: Record<string, unknown> = Object(Reflect.get(imports, 'gojs'));
        const wasmExit = gojs['runtime.wasmExit'];
        let watched = imports;
        if (typeof wasmExit === 'function') {
          const onExit = (sp: number): unknown => {
            exit();
            return Reflect.apply(wasmExit, undefined, [sp]);
          };
          watched = { ...imports, gojs: { ...gojs, 'runtime.wasmExit': onExit } } as WebAssembly.Imports;
        }
        const instance = await WebAssembly.instantiate(module, watched);
        memory = instance.exports.mem;
        return instance;
      },
    },
  });
  const esbuild = newEsbuild(observed);
  await esbuild.initialize({ wasmModule, worker: false });
  if (!(memory instanceof WebAssembly.Memory)) {
    await esbuild.stop();
    throw new Error('esbuild did not export its linear memory');
  }
  const linear = memory;
  return {
    esbuild: {
      transform: (input, options) => new Promise<TransformOutput>((resolve, reject) => {
        if (closed) {
          reject(stopped());
          return;
        }
        pending.add(reject);
        esbuild.transform(input, options).then((result) => {
          pending.delete(reject);
          const output = { ...result };
          result.code = '';
          result.map = '';
          resolve(output);
        }, (error: unknown) => {
          pending.delete(reject);
          if (error instanceof WebAssembly.RuntimeError) closed = true;
          if (!(error instanceof Error)) {
            reject(error);
            return;
          }
          // The kept promise holds its error too, and an error's unformatted
          // stack holds the frames that made it: the transform, and its input.
          const failure = Object.assign(new Error(error.message), {
            errors: Reflect.get(error, 'errors'),
            warnings: Reflect.get(error, 'warnings'),
          });
          if (closed) Reflect.set(failure, 'transient', true);
          error.stack = '';
          Reflect.set(error, 'errors', []);
          Reflect.set(error, 'warnings', []);
          reject(failure);
        });
      }),
      stop: () => esbuild.stop(),
    },
    memoryBytes: () => linear.buffer.byteLength,
    closed: () => closed,
  };
}
