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
import { ReplSession } from './repl-session.js';
import { buildCPythonPreamble } from './cpython-runner.js';
import { getFacetManagerLoaderHost } from './facet-loader-host.js';
import { CRED_KERNEL } from './os-contracts.js';
/** Written by the driver when the source so far cannot yet be run. */
const INCOMPLETE_MARKER = '__NIMBUS_PY_INCOMPLETE__';
/** Where cpython-runner's catalog spec stages the interpreter. */
const CPYTHON_WASM_REL = 'share/cpython/python.wasm';
const CPYTHON_STDLIB_REL = 'share/cpython/python313.zip';
const CPYTHON_HOME = '/usr/local';
function toArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
/**
 * The per-submission driver, as Python source.
 *
 * Source arrives base64-encoded: a REPL line can contain any quoting, any
 * newline and any unicode, and encoding it is cheaper than being certain about
 * every escape on the way through.
 */
function buildReplDriver(source) {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(source)));
    return [
        'import base64, codeop, sys, traceback',
        'import __main__',
        `__nimbus_src = base64.b64decode("${b64}").decode("utf-8")`,
        '__nimbus_code = False',
        'try:',
        '    __nimbus_code = codeop.compile_command(__nimbus_src, "<stdin>", "single")',
        'except SyntaxError:',
        // A SyntaxError here is source that can never complete, so report it and
        // take the next line rather than leaving the user in a continuation they
        // cannot escape.
        '    traceback.print_exc(limit=0)',
        'except (OverflowError, ValueError):',
        '    traceback.print_exc(limit=0)',
        'if __nimbus_code is None:',
        `    sys.stdout.write("${INCOMPLETE_MARKER}")`,
        'elif __nimbus_code is not False:',
        '    try:',
        '        exec(__nimbus_code, __main__.__dict__)',
        '    except SystemExit:',
        // Let it out: nimbus_py_run turns it into the exit status, which is how
        // exit() and Ctrl-D leave the prompt.
        '        raise',
        '    except BaseException:',
        '        traceback.print_exc()',
    ].join('\n');
}
class PythonReplAdapter {
    pool = null;
    deps;
    wasmBytes = null;
    fsSnapshot = null;
    ps1 = '>>> ';
    ps2 = '... ';
    constructor(deps) {
        this.deps = deps;
    }
    banner() {
        return ('Python 3.13.14 (CPython, wasm32-wasi, Nimbus runtime)\r\n' +
            'Type "exit()" or press Ctrl-D to exit.\r\n');
    }
    async push(source) {
        const trimmed = source.trim();
        if (trimmed === 'exit' || trimmed === 'quit') {
            return { kind: 'output', stdout: '', stderr: 'Use exit() or Ctrl-D to exit\n' };
        }
        try {
            await this.ensurePool();
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { kind: 'error', stderr: `[python-repl] bootstrap failed: ${message}\n` };
        }
        let result;
        try {
            result = await this.submit(buildReplDriver(source));
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { kind: 'error', stderr: `[python-repl] dispatch failed: ${message}\n` };
        }
        if (result.stdout.includes(INCOMPLETE_MARKER))
            return { kind: 'incomplete' };
        if (result.exitCode !== 0) {
            // A runner-level failure is the only account of why the session is
            // ending; dropping it turns a broken interpreter into a silent return to
            // the shell.
            return {
                kind: 'exit',
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr + (result.error ? `[python-repl] ${result.error}\n` : ''),
            };
        }
        return { kind: 'output', stdout: result.stdout, stderr: result.stderr };
    }
    async close() {
        if (this.pool) {
            try {
                this.pool.dispose?.();
            }
            catch { /* fail-soft: the session is ending anyway */ }
            this.pool = null;
        }
    }
    async ensurePool() {
        if (this.pool)
            return;
        const { installRoot, facetMgr } = this.deps;
        const vfs = this.deps.vfs.as(CRED_KERNEL);
        const wasmPath = `${installRoot}/${CPYTHON_WASM_REL}`;
        const stdlibPath = `${installRoot}/${CPYTHON_STDLIB_REL}`;
        if (!vfs.exists(wasmPath)) {
            throw new Error(`python.wasm missing at ${wasmPath} (run 'nimbus install python')`);
        }
        if (!vfs.exists(stdlibPath)) {
            throw new Error(`python313.zip missing at ${stdlibPath} (run 'nimbus install python')`);
        }
        this.wasmBytes = toArrayBuffer(vfs.readFile(wasmPath));
        const { manifestVfs } = await import('./vfs-manifest.js');
        const stdlibDir = stdlibPath.replace(/\/[^/]+$/, '');
        const built = manifestVfs(vfs, 'home/user', { extraRoots: [stdlibDir] });
        if ('error' in built)
            throw new Error(built.error);
        this.fsSnapshot = aliasStdlibInto(built.snapshot, stdlibPath.replace(/^\/+/, ''));
        const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
        const host = getFacetManagerLoaderHost(facetMgr);
        // A prompt where `open(path, "w")` silently does nothing is worse than one
        // that refuses to start, so the pid decides which pool this is. Written as
        // two literals rather than a spread because the rule that catches this
        // mistake (tests/unit/runtime-pool-supervisor-pid.mjs) reads the options
        // object as text, and a pool whose credential is hidden behind a variable
        // is exactly the shape it exists to find.
        const base = {
            // Distinct from cpython-runner's tag: a REPL facet holds a live
            // interpreter and must never be handed a one-shot invocation.
            tag: 'python-repl',
            concurrency: 1,
            preamble: buildCPythonPreamble(),
            wasmModules: { 'python.wasm': this.wasmBytes },
        };
        const pid = this.deps.pid;
        this.pool = (typeof pid === 'number' && pid > 0
            ? new NimbusLoaderPool(host.env, host.ctx, { ...base, supervisorPid: pid })
            // The install-time warm-up has no invoking process. It boots the
            // interpreter and never touches a file, so it asks for no supervisor
            // rather than binding one it cannot authenticate to.
            : new NimbusLoaderPool(host.env, host.ctx, { ...base, omitSupervisor: true }));
    }
    async submit(userCode) {
        const result = await this.pool.submit(pythonReplStepFacetFn, {
            userCode,
            pythonHome: CPYTHON_HOME,
            pyArgv: ['python'],
            userEnv: { HOME: '/home/user', PYTHONUNBUFFERED: '1' },
            progName: 'python',
            cwd: '/home/user',
            fsSnapshot: this.fsSnapshot,
        }, { timeoutMs: 60_000 });
        return result;
    }
}
/**
 * The interpreter looks for its stdlib under /usr/local, but the install put it
 * wherever the manifest says. Aliasing the two paths the guest needs is cheaper
 * than moving 3.6 MiB, and the zip's content is demand-loaded either way.
 */
function aliasStdlibInto(snapshot, stdlibManifestPath) {
    snapshot.dirs = [...snapshot.dirs, 'usr', 'usr/local', 'usr/local/lib',
        'usr/local/lib/python3.13', 'usr/local/lib/python3.13/lib-dynload'];
    for (const d of snapshot.dirs)
        snapshot.modes[d] = 7;
    snapshot.files['usr/local/lib/python3.13/os.py'] = btoa('# stdlib marker; the modules live in the zip\n');
    snapshot.modes['usr/local/lib/python3.13/os.py'] = 7;
    snapshot.modes['usr/local/lib/python313.zip'] = 7;
    // Size from the manifest walk rather than a second stat.
    snapshot.sizes = snapshot.sizes || {};
    snapshot.sizes['usr/local/lib/python313.zip'] = snapshot.sizes[stdlibManifestPath] ?? 0;
    return snapshot;
}
/**
 * Facet-side. Serialized with fn.toString(), so it captures nothing and names
 * no import: __cpythonReplRun is put on globalThis by the preamble, and unlike
 * __cpythonRun it keeps its interpreter between calls.
 */
function pythonReplStepFacetFn(args) {
    const g = globalThis;
    const run = g.__cpythonReplRun;
    if (typeof run !== 'function') {
        return Promise.resolve({
            stdout: '', stderr: '', exitCode: 127,
            error: 'cpython preamble missing: __cpythonReplRun not in scope',
        });
    }
    return run(args);
}
export async function runPythonRepl(deps) {
    const adapter = new PythonReplAdapter(deps);
    const session = new ReplSession(adapter, deps.terminal, deps.shell);
    return await session.run();
}
/**
 * Pay the interpreter's boot before the user asks for a prompt. Pushing empty
 * source compiles to a no-op, so the only thing it does is bring the facet up.
 */
export async function warmPythonRepl(deps) {
    const adapter = new PythonReplAdapter(deps);
    await adapter.push('');
    await adapter.close();
}
