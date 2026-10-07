import type { FacetBindings } from '@nimbus-sh/core/runtime/facet-host.js';
import type { Shell } from '@nimbus-sh/core/substrate/lifo/shell/Shell.js';
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
import type { FacetManager } from '../facets/manager.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { RuntimeManifest } from '@nimbus-sh/core/runtime/runtime-manifest.js';
import { type NimbusFilesystemAuthority } from '@nimbus-sh/core/runtime/os-contracts.js';
export interface PythonReplDeps {
    facetMgr: FacetManager;
    /** Owns the installed interpreter blobs the prompt is booted from. */
    authority: NimbusFilesystemAuthority;
    terminal: WebSocketTerminal;
    /** Per-user-VFS install dir, e.g. 'home/user/.nimbus/runtimes/cpython/3.13.14'. */
    installRoot: string;
    /** The invoking command's HOME: its pip packages decide the interpreter, and the prompt runs with it. */
    home: string;
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
    shell?: Pick<Shell, 'takeQueuedInput'>;
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
    /**
     * Where the prompt starts: the shell's working directory, entered once
     * per interpreter, and the command that started it, which a refusal to
     * enter names. Absent only for the install-time warm-up.
     */
    start?: {
        cwd: string;
        binName: string;
    };
}
/**
 * What one prompt line hands the facet (__cpythonReplRun): the driver, the
 * interpreter's setup, and `enter`, the source that starts the prompt in the
 * shell's working directory, which the facet runs once per interpreter.
 */
export declare function pythonReplStep(deps: Pick<PythonReplDeps, 'home' | 'start' | 'pid'>, pythonHome: string, userCode: string): {
    enter?: string | undefined;
    userCode: string;
    supervisorPid: number;
    outputControls: ({
        key: string;
        prefix: string;
        suffix?: undefined;
    } | {
        key: string;
        prefix: string;
        suffix: string;
    })[];
    pythonHome: string;
    pyArgv: string[];
    userEnv: {
        HOME: string;
        PYTHONUNBUFFERED: string;
    };
    progName: string;
};
/**
 * Facet-side, request-shaped: serialized with fn.toString() into the
 * pool's fetch entrypoint, so it captures nothing and names no import —
 * __cpythonReplRun is put on globalThis by the preamble, and unlike
 * __cpythonRun it keeps its interpreter between calls. The request body
 * is the step payload the adapter JSON-encodes; the response is the
 * step result. Request transport because it is the pool's only
 * cancellable dispatch: Ctrl-C aborts the request, workerd stops the
 * interpreter at its suspension point.
 */
export declare function pythonReplStepRequestFn(request: Request, facetEnv: FacetBindings): Promise<Response>;
export declare function runPythonRepl(deps: PythonReplDeps): Promise<number>;
/**
 * Pay the interpreter's boot before the user asks for a prompt. Pushing empty
 * source compiles to a no-op, so the only thing it does is bring the facet up.
 */
export declare function warmPythonRepl(deps: Pick<PythonReplDeps, 'facetMgr' | 'authority' | 'installRoot' | 'home' | 'manifest'>): Promise<void>;
//# sourceMappingURL=python-repl.d.ts.map