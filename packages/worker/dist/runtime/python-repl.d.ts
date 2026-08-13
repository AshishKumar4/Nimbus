/**
 * python-repl.ts — the interactive `python` prompt.
 *
 * A long-lived facet holds one interpreter and each submitted line is run in
 * it, so definitions, imports and open files survive between prompts. That is
 * the whole reason the interpreter is built as a WASI reactor: a command
 * module's _start runs once.
 *
 * Incompleteness is decided by `codeop.compile_command`, which is what the real
 * Python REPL uses — it returns None for source that is syntactically fine so
 * far but unfinished (an open bracket, a `def` with no body yet), raises
 * SyntaxError for source that can never complete, and otherwise hands back a
 * code object. That distinction is not something to re-derive from error
 * strings; the previous Pyodide implementation asked PyodideConsole for it,
 * which is the same idea reached through a Pyodide-only object.
 *
 * Compiling in 'single' mode also gets the echo right for free: an expression
 * statement goes through sys.displayhook exactly as it does at a real prompt,
 * so `1 + 1` prints `2` and `x = 1` prints nothing, with no wrapper of ours
 * deciding what counts as a result.
 */
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { FacetManager } from '../facets/manager.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { RuntimeManifest } from '@nimbus-sh/core/runtime/runtime-manifest.js';
export interface PythonReplDeps {
    facetMgr: FacetManager;
    vfs: SqliteVFS;
    terminal: WebSocketTerminal;
    /** Per-user-VFS install dir, e.g. 'home/user/.nimbus/runtimes/cpython/3.13.14'. */
    installRoot: string;
    manifest: RuntimeManifest;
    /**
     * The Nimbus shell, when there is one.
     *
     * A multi-line WebSocket frame (`python\nexit(7)`) is split by the shell's
     * input handler, which pushes everything after the first line onto
     * shell.pasteQueue and drains it only when the shell goes idle. The shell is
     * not idle: it is blocked awaiting this REPL. Handing the shell to
     * ReplSession lets it drain that queue on attach, which is the difference
     * between the pasted tail arriving and the prompt hanging.
     */
    shell?: unknown;
    /**
     * The invoking process's pid.
     *
     * The supervisor derives the write credential from it, so a pool that binds
     * SUPERVISOR without one has a filesystem it can read and can never write —
     * every write-back comes back "missing or invalid process pid in props".
     * Absent only for the install-time warm-up, which boots the interpreter and
     * never touches a file.
     */
    pid?: number;
}
export declare function runPythonRepl(deps: PythonReplDeps): Promise<number>;
/**
 * Pay the interpreter's boot before the user asks for a prompt. Pushing empty
 * source compiles to a no-op, so the only thing it does is bring the facet up.
 */
export declare function warmPythonRepl(deps: Pick<PythonReplDeps, 'facetMgr' | 'vfs' | 'installRoot' | 'manifest'>): Promise<void>;
//# sourceMappingURL=python-repl.d.ts.map