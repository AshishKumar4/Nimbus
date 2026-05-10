/**
 * wasm-runner.ts — native-WASM runner via runtime-registry.
 *
 * The first non-Node runtime shipped to Nimbus. Demonstrates the
 * runtime-registry pattern with a tiny, end-to-end-working surface:
 *
 *   wasm-runner --version
 *   wasm-runner /path/to/file.wasm <exportName> [int args...]
 *
 * Reads the .wasm bytes from VFS, instantiates via
 * WebAssembly.instantiate (workerd built-in — no vendored
 * interpreter), looks up the named export (must be a function),
 * calls with the parsed integer args, prints the return value.
 *
 * Architectural notes
 * ───────────────────
 * Unlike `node` / `bun`, this runtime DOES NOT route through the
 * Worker Loader facet pool. Reason: the work is pure
 * compute-on-bytes — no userspace JS to isolate, no FS / network
 * concerns, no multi-call shared state. Running inside the
 * supervisor's existing isolate is correct AND simpler. If a future
 * use case wants per-call isolation (e.g. untrusted .wasm), the
 * spec.run() function can be swapped to dispatch through
 * facetMgr.exec without changing the registry contract.
 *
 * Stdout/stderr semantics
 * ───────────────────────
 * The bytes-execution pathway has no notion of stdout/stderr — the
 * .wasm just returns a number from a function call. We surface the
 * result as one line on stdout (the runner's convention; the user's
 * actual program output, if any, would have to come through WASI
 * imports — out of scope this wave).
 *
 * PID + Process tab semantics
 * ───────────────────────────
 * Even though there's no facet, we DO allocate a processTable PID
 * and emit spawn/exit terminal events the same way other runtimes
 * do — so `ps` / `logs <pid>` / Process tab UX is identical. This
 * is the runtime-agnostic primitive #3 path: one PID per
 * invocation, regardless of where the actual work runs.
 *
 * Anti-requirements
 * ─────────────────
 *   - NO setTimeout / NO sleep / NO retry / NO defensive-catch
 *   - The try/catch around vfs.readFile and WebAssembly.instantiate
 *     are legitimate I/O / parse boundaries: they propagate the
 *     diagnostic into stderr and return a non-zero exit code.
 */

import type { RuntimeRunOpts, RuntimeRunResult } from './runtime-registry.js';

export const WASM_RUNNER_VERSION = '0.1.0';

export const WASM_RUNNER_HELP =
  'Usage: wasm-runner [options] <file.wasm> <exportName> [int args...]\n' +
  '       wasm-runner --version\n' +
  '\n' +
  'Loads a .wasm module, calls the named export with integer args,\n' +
  'prints the return value.\n' +
  '\n' +
  'Examples:\n' +
  '  wasm-runner ./hello.wasm add 3 4         # → 7\n' +
  '  wasm-runner ./fib.wasm fib 10            # → 55\n' +
  '\n' +
  'Limitations:\n' +
  '  - Function args are integers only (parseInt). Float / string /\n' +
  '    multi-arg-shapes need a wrapper module.\n' +
  '  - Only WebAssembly.Memory and integer return values are surfaced.\n' +
  '  - WASI imports are NOT provided. Modules expecting wasi_snapshot\n' +
  '    won\'t instantiate.';

/**
 * Minimal VFS shape we depend on. Avoids importing the full
 * SqliteVFS type tree from the supervisor module graph (this file
 * is part of `src/runtime/`, importing supervisor-specific types
 * would create a cycle).
 */
interface VfsLike {
  exists(path: string): boolean;
  readFile(path: string): Uint8Array;
}

/**
 * Build a `run` function suitable for RuntimeSpec.run(). Parameterised
 * over the VFS so the host wires its own SqliteVFS in. Returns a fn
 * that matches the registry's contract.
 */
export function makeWasmRunner(vfs: VfsLike) {
  return async function runWasm(
    _facetMgr: unknown,
    _code: string,
    opts: RuntimeRunOpts,
  ): Promise<RuntimeRunResult> {
    // opts.filename is the resolved .wasm path (absolute, /-prefixed).
    // opts.argv is [exportName, intArg1, intArg2, ...].
    const wasmPath = (opts.filename || '').replace(/^\/+/, '');
    const argv = opts.argv || [];
    const exportName = argv[0];
    const intArgs = argv.slice(1);

    if (!exportName) {
      return {
        exitCode: 1,
        stdout: '',
        stderr:
          `wasm-runner: missing export name\n` +
          `Usage: wasm-runner ${opts.filename} <exportName> [int args...]\n`,
      };
    }

    if (!vfs.exists(wasmPath)) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `wasm-runner: cannot find module '${opts.filename}'\n`,
      };
    }

    let bytes: Uint8Array;
    try {
      bytes = vfs.readFile(wasmPath);
    } catch (e: any) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `wasm-runner: cannot read '${opts.filename}': ${e?.message || e}\n`,
      };
    }

    let instance: WebAssembly.Instance;
    try {
      // WebAssembly.instantiate has two overloads:
      //   (bytes, importObject) → { module, instance }
      //   (module, importObject) → instance
      // We pass bytes; result is the WebAssemblyInstantiatedSource
      // shape. Cast through any to avoid the `instance: Instance`
      // overload-resolution issue in @cloudflare/workers-types.
      const result = (await WebAssembly.instantiate(bytes as any, {})) as any;
      instance = result.instance;
    } catch (e: any) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `wasm-runner: instantiate failed: ${e?.message || e}\n`,
      };
    }

    const fn = (instance.exports as any)[exportName];
    if (typeof fn !== 'function') {
      const available = Object.keys(instance.exports).join(', ');
      return {
        exitCode: 1,
        stdout: '',
        stderr:
          `wasm-runner: export '${exportName}' is not a function (or not exported)\n` +
          `Available exports: ${available}\n`,
      };
    }

    // Parse integer args. Non-integer values are reported as a clear
    // diagnostic rather than silently coerced (Number() would map
    // 'foo' → NaN which the wasm fn would treat as 0 — confusing).
    const parsedArgs: number[] = [];
    for (let i = 0; i < intArgs.length; i++) {
      const n = parseInt(intArgs[i], 10);
      if (!Number.isFinite(n)) {
        return {
          exitCode: 1,
          stdout: '',
          stderr:
            `wasm-runner: argument ${i + 1} ('${intArgs[i]}') is not an integer\n`,
        };
      }
      parsedArgs.push(n);
    }

    let result: any;
    try {
      result = fn(...parsedArgs);
    } catch (e: any) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `wasm-runner: ${exportName}(${parsedArgs.join(', ')}) threw: ${e?.message || e}\n`,
      };
    }

    // Most simple wasm fns return a number (i32/i64/f32/f64). For i64
    // workerd surfaces a BigInt; coerce to its string form. For
    // 'undefined' (void return), print nothing — exit 0.
    if (result === undefined || result === null) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return {
      exitCode: 0,
      stdout: String(result) + '\n',
      stderr: '',
    };
  };
}
