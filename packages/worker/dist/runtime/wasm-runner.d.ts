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
 *   2. Allocates a PID via the process supervisor (Process tab integration).
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
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
export declare const WASM_RUNNER_VERSION = "0.3.0";
export declare const WASM_RUNNER_HELP: string;
export declare function formatWasmRunnerWasiInfo(): string;
/**
 * Build a `run` function suitable for RuntimeSpec.run(). Parameterised
 * over the VFS, env (for env.LOADER), ctx (for the pool's doId-scoped
 * cache key), and the session process supervisor (for `ps` /
 * `logs <pid>` / Process tab integration). Returns a fn that matches
 * the runtime-registry's contract.
 */
export declare function makeWasmRunner(deps: {
    vfs: SqliteVFS;
    env: any;
    ctx: DurableObjectState;
    processes: SessionProcessSupervisor;
}): (_facetMgr: unknown, _code: string, opts: RuntimeRunOpts) => Promise<RuntimeRunResult>;
//# sourceMappingURL=wasm-runner.d.ts.map