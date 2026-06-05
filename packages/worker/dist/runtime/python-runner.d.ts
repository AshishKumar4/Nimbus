/**
 * python-runner.ts — Pyodide v0.29.4 runner (runtime package manager v2 / Pyodide v1).
 *
 * D1-D7:
 *   - `python --version` / `python -c '<code>'` / `python script.py`
 *   - stdlib subset (full python_stdlib.zip ships)
 *   - stdout/stderr → processLogs (Process tab integration)
 *   - exit code via sys.exit(N) or unhandled exception → 1
 *   - argv passed through to sys.argv
 *
 * Out of v1 (queued for v2/v3):
 *   - REPL mode (`python` with no args)
 *   - File I/O beyond reading the entry script
 *   - `pip install` / `loadPackage` / native-extension packages
 *   - Sync HTTP (urllib3 / requests blocked without JSPI)
 *
 * Architecture: SAME LOADER-modules transport as clang-runner/wasm-
 * runner. The Pyodide wasm bytes ship via the LOADER `modules` map
 * (CSP allows wasm code-gen at module-load time, not at request
 * time). The Pyodide.asm.js + stdlib zip ride via the loader-pool
 * `context` field (JSON-stringified into the inner worker.js at
 * module-load).
 *
 * Per wasm-csp/findings.md §4b: Pyodide.asm.wasm (10.1 MB on disk)
 * compiles in 314 ms via LOADER on PROD. With our v1 deployment of
 * 0.29.4 (8.25 MB asm.wasm), this is well under the empirical
 * ~32 MiB per-call ceiling.
 */
import type { RuntimeManifest } from './runtime-catalog.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { FacetManager } from '../facets/manager.js';
/**
 * Build the python-runner factory. Called once at session init; the
 * returned factory binds the manifest + install root for each
 * registered entrypoint (`python`, `python3`).
 */
export declare function makePythonRunnerFactory(deps: {
    facetMgr: FacetManager;
    vfs: SqliteVFS;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => (ctx: any) => Promise<number>;
/**
 * Compose the per-call preamble by splicing the pyodide.asm.js source
 * verbatim ahead of the __pyodideRun helper. Workerd compiles this
 * blob as JS at module-load time (where `var` declarations + globals
 * assignment are allowed), then the asm.js's `var _createPyodideModule`
 * is hoisted onto globalThis.
 */
export declare function buildPyodidePreamble(asmJsSrc: string, stdlibB64: string): string;
//# sourceMappingURL=python-runner.d.ts.map