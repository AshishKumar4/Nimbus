/**
 * wasm-runner.ts — native-WASM runner over the facet host.
 *
 * The runner never compiles the user's bytes itself: it hands them to a facet
 * ({@link ./facet-host.js}) as `user.wasm` and reads the compiled
 * `WebAssembly.Module` back off `globalThis.__NIMBUS_WASM['user.wasm']`. On
 * workerd that indirection is not stylistic — direct
 * `WebAssembly.instantiate(bytes)` is refused by CSP at request time in both
 * the supervisor and facet isolates, and the modules map is the one path where
 * the compile happens during module load, which is permitted.
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
 *   3. Facet.submit() with wasmModules: { 'user.wasm': bytes } — the
 *      host compiles the image and publishes it on the facet's
 *      `globalThis.__NIMBUS_WASM`.
 *   4. The submitted fn runs inside the inner facet:
 *      - reads globalThis.__NIMBUS_WASM['user.wasm'] (the precompiled
 *        Module the facet host registered)
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
 *   - No sleeps, caller-side retries, or catch-and-continue around facet
 *     failures. The host owns retry behavior.
 *   - The try/catch around vfs.readFile is a legitimate I/O boundary;
 *     the diagnostic propagates as exitCode 1 + stderr line.
 *   - NO direct WebAssembly.instantiate(bytes) at request time — workerd
 *     CSP rejects that path, and the facet host exists to make it moot.
 */
import type { RuntimeRunOpts, RuntimeRunResult, RuntimeSpec } from './runtime-registry.js';
import type { FacetHost } from './facet-host.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
export declare const WASM_RUNNER_VERSION = "0.3.0";
export declare const WASM_RUNNER_HELP: string;
export declare function formatWasmRunnerWasiInfo(): string;
/**
 * Build a `run` function suitable for RuntimeSpec.run(). Parameterised
 * over the VFS, the facet host the module is compiled and run on, and the
 * session process supervisor (for `ps` / `logs <pid>` / Process tab
 * integration). Returns a fn that matches the runtime-registry's contract.
 */
export declare function makeWasmRunner(deps: {
    vfs: SqliteVFS;
    facets: FacetHost;
    processes: SessionProcessSupervisor;
}): (_code: string, opts: RuntimeRunOpts) => Promise<RuntimeRunResult>;
/**
 * The `wasm-runner` command, whole.
 *
 * Its name, its version, its help and its `--wasi-info` verb belong to the
 * runner, not to whoever registers it. Two callers restating them — a Durable
 * Object session and an embedded workspace — is two places for the help text
 * to drift from the shim it describes.
 */
export declare function wasmRunnerSpec(deps: {
    vfs: SqliteVFS;
    facets: FacetHost;
    processes: SessionProcessSupervisor;
}): RuntimeSpec;
//# sourceMappingURL=wasm-runner.d.ts.map