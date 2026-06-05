/**
 * wasm-runner.ts — native-WASM runner via the LOADER-modules transport.
 *
 * Direct `WebAssembly.instantiate(bytes)` is blocked by workerd CSP at
 * request time in both the supervisor and facet isolates. This runner routes
 * through the LOADER modules map:
 * bytes ride INSIDE the worker code blob, workerd compiles them
 * during the inner worker's MODULE-LOAD phase (the one phase where
 * wasm code generation IS allowed), and the resulting
 * WebAssembly.Module is exposed to the user fn via the
 * NimbusLoaderPool's `globalThis.__NIMBUS_WASM[<name>]` table.
 *
 * Shell command shape
 * ───────────────────
 *
 *   wasm-runner --version
 *   wasm-runner <file.wasm> <exportName> [int args...]
 *
 * Each invocation:
 *   1. Reads bytes from VFS (or any caller-supplied source).
 *   2. Allocates a PID via processTable (Process tab integration).
 *   3. NimbusLoaderPool.submit() with wasmModules: { 'user.wasm': bytes }
 *      — pool merges per-call wasm with constructor-time entries,
 *      generates a worker.js that imports './user.wasm', and ships
 *      the modules map to env.LOADER.get(...).
 *   4. The submitted fn runs inside the inner facet:
 *      - reads globalThis.__NIMBUS_WASM['user.wasm'] (the precompiled
 *        Module the pool registered)
 *      - WebAssembly.instantiate(module, {}) — allowed because the
 *        Module is precompiled
 *      - looks up the export, calls with parsed integer args, returns
 *        the result + the export list
 *   5. Supervisor formats and writes stdout/stderr; exit code 0/1.
 *
 * Limitations (documented in --help):
 *   - Function args are integers only (parseInt). Float / string /
 *     multi-arg-shapes need a wrapper module.
 *   - Only WebAssembly.Memory and integer return values are surfaced.
 *   - WASI imports are NOT provided. Modules expecting wasi_snapshot
 *     won't instantiate (fail at the in-facet instantiate step).
 *
 * Dispatch constraints
 * ────────────────────
 *   - No sleeps, caller-side retries, or catch-and-continue around loader
 *     failures. The pool's resilience options own retry behavior.
 *   - The try/catch around vfs.readFile is a legitimate I/O boundary;
 *     the diagnostic propagates as exitCode 1 + stderr line.
 *   - NO direct WebAssembly.instantiate(bytes) at request time —
 *     workerd CSP rejects that path.
 */
import type { RuntimeRunOpts, RuntimeRunResult } from './runtime-registry.js';
export declare const WASM_RUNNER_VERSION = "0.3.0";
export declare const WASM_RUNNER_HELP: string;
/**
 * Minimal VFS shape we depend on. Avoids importing the full
 * SqliteVFS type tree from the supervisor module graph — this file
 * is part of `src/runtime/`, importing supervisor-specific types
 * would create a cycle.
 *
 * filesystem WASI: extended for WASI file-IO. The snapshot path uses readdir +
 * isDirectory + stat to traverse the user's session subtree; the
 * flush path uses writeFile + mkdir + unlink + rmdir.
 */
interface VfsLike {
    exists(path: string): boolean;
    isDirectory(path: string): boolean;
    readFile(path: string): Uint8Array;
    writeFile(path: string, content: Uint8Array | string): void;
    readdir(path: string): {
        name: string;
        type: string;
    }[];
    mkdir(path: string, opts?: {
        recursive?: boolean;
    }): void;
    unlink(path: string): void;
    rmdir(path: string): void;
}
/**
 * Minimal processTable shape — the parts wasm-runner needs to
 * register a PID + mark exit so `ps` and `logs <pid>` see the
 * invocation. Mirrors the surface the .bin handler uses; kept
 * narrow to avoid the cycle through facets/manager.ts.
 */
interface ProcessTableLike {
    spawn(command: string, argv: string[], cwd: string): {
        pid: number;
    };
    exit(pid: number, code: number): void;
}
interface ProcessLogStoreLike {
    append(pid: number, stream: 'stdout' | 'stderr', data: string): void;
    getExit(pid: number): unknown;
    markExit(pid: number, code: number): void;
}
/**
 * Build a `run` function suitable for RuntimeSpec.run(). Parameterised
 * over the VFS, env (for env.LOADER), ctx (for the pool's doId-scoped
 * cache key), and processTable + processLogs (for `ps` / `logs <pid>` /
 * Process tab integration). Returns a fn that matches the runtime-
 * registry's contract.
 */
export declare function makeWasmRunner(deps: {
    vfs: VfsLike;
    env: any;
    ctx: DurableObjectState;
    processTable: ProcessTableLike;
    processLogs: ProcessLogStoreLike;
}): (_facetMgr: unknown, _code: string, opts: RuntimeRunOpts) => Promise<RuntimeRunResult>;
export {};
//# sourceMappingURL=wasm-runner.d.ts.map