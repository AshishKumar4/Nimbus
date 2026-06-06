/**
 * python-repl.ts — Python REPL adapter (Pyodide 0.29.4).
 *
 * Implements ReplAdapter for the `python` shell command's no-args
 * invocation. Reuses the existing Pyodide v2 preamble built by
 * python-runner.ts's `buildPyodidePreamble`; this file only adds:
 *   1. A REPL-step facet fn that pushes a line into a long-lived
 *      pyodide.console.PyodideConsole instance and returns the
 *      result.
 *   2. Adapter wiring (banner, push, close, ps1/ps2 prompts).
 *
 *   - State persistence: same NimbusLoaderPool reference held across
 *     submits → same child-facet isolate → globalThis.__nimbusPyodideInstance
 *     persists.
 *   - Continuation prompts: PyodideConsole's runsource() returns an
 *     'incomplete' status when input is mid-block (e.g. unclosed
 *     `def f():`); the adapter signals 'incomplete' back to ReplSession,
 *     which renders ps2 ('... ') and accumulates.
 *   - sys.exit() / exit() / quit(): captured via SystemExit on the
 *     pyodide.console.Console runtime; returned as ReplPushResult
 *     'exit' with the captured code.
 *
 * NOT supported in v1 (deferred to W5+):
 *   - top-level await at the REPL prompt (Pyodide supports this via
 *     runPythonAsync; v1 uses runsource synchronously).
 *   - Tab-completion (PyodideConsole has rlcompleter; surface deferred).
 *   - SIGINT mid-statement (no interrupt-buffer plumbing yet).
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { FacetManager } from '../facets/manager.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { RuntimeManifest } from './runtime-catalog.js';
/** Inputs needed to bootstrap a Pyodide REPL session. */
export interface PythonReplDeps {
    facetMgr: FacetManager;
    vfs: SqliteVFS;
    terminal: WebSocketTerminal;
    /** Per-user-VFS install dir, e.g. 'home/user/.nimbus/runtimes/python/0.29.4'. */
    installRoot: string;
    manifest: RuntimeManifest;
    /**
     * REPL-R7-1 (2026-05-12): optional lifo-sh Shell reference.
     *
     * When a user pastes / sends a multi-line WS frame like
     * `python\nexit(7)`, lifo-sh's input handler splits on \r\n and
     * pushes everything after the first line into shell.pasteQueue.
     * Those lines are processed ONLY when the shell becomes idle —
     * but our REPL is running and the shell is blocked awaiting
     * runPythonRepl. Result: REPL hangs at `>>> ` because the input
     * never reaches it.
     *
     * Threading shell here lets ReplSession drain pasteQueue
     * immediately on attach. If undefined, the REPL still works for
     * single-line invocations (the common case) — it just won't
     * recover paste-pending input.
     */
    shell?: any;
}
/**
 * Top-level wrapper: builds a Python REPL adapter, drives a
 * ReplSession to completion, returns the exit code.
 *
 * Called from the python factory's wrapper in init.ts when the user
 * runs `python` with no args.
 */
export declare function runPythonRepl(deps: PythonReplDeps): Promise<number>;
export declare function warmPythonRepl(deps: Pick<PythonReplDeps, 'facetMgr' | 'vfs' | 'installRoot' | 'manifest'>): Promise<void>;
//# sourceMappingURL=python-repl.d.ts.map