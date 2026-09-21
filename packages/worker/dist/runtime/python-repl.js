import { IsolatePool } from '@nimbus-sh/fabric/isolate-pool.js';
import { withHostFilesystem } from '@nimbus-sh/core/shell/execution-fs.js';
import { z } from 'zod/v4';
import { ReplSession } from './repl-session.js';
import { sessionUsesSciVariant } from '@nimbus-sh/core/runtime/python-pip.js';
import { buildCPythonPreamble } from '@nimbus-sh/core/runtime/cpython-runner.js';
import { getFacetManagerLoaderHost } from './facet-loader-host.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
/** Written by the driver when the source so far cannot yet be run. */
const INCOMPLETE_MARKER = '__NIMBUS_PY_INCOMPLETE__';
/**
 * Written when SystemExit reaches top level.
 *
 * The exit STATUS cannot carry this on its own: `exit()` and `exit(0)` both
 * mean "leave the prompt" and both have status 0, which is exactly what a line
 * that ran fine also returns. Without a marker the REPL treats `exit()` as
 * ordinary output and never leaves.
 */
const EXIT_MARKER = '__NIMBUS_PY_EXIT__';
const PythonFacetResult = z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number().int(), error: z.string().optional() });
const PythonFacetFailure = z.object({ __nimbusFacetError: z.string() });
/** Where cpython-runner's catalog spec stages the interpreter. */
const CPYTHON_WASM_REL = 'share/cpython/python.wasm';
const CPYTHON_SCI_WASM_REL = 'share/cpython/python-sci.wasm';
const CPYTHON_SCI_PACKAGES_REL = 'lib/sci-packages.zip';
const CPYTHON_STDLIB_REL = 'lib/python313.zip';
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
        '    except SystemExit as __nimbus_exit:',
        // Caught rather than re-raised: the marker is what distinguishes leaving
        // the prompt from a line that merely succeeded.
        '        __nimbus_code = __nimbus_exit.code',
        '        if __nimbus_code is None:',
        '            __nimbus_code = 0',
        '        elif not isinstance(__nimbus_code, int):',
        '            sys.stderr.write(str(__nimbus_code) + "\\n")',
        '            __nimbus_code = 1',
        `        sys.stdout.write("${EXIT_MARKER}" + str(__nimbus_code) + ":")`,
        '    except BaseException:',
        '        traceback.print_exc()',
    ].join('\n');
}
class PythonReplAdapter {
    pool = null;
    /** Which interpreter variant the cached pool holds; see ensurePool. */
    poolUsesSci = false;
    deps;
    wasmBytes = null;
    pythonHome = '/usr/local';
    ps1 = '>>> ';
    ps2 = '... ';
    constructor(deps) {
        this.deps = deps;
    }
    banner() {
        return ('Python 3.13.14 (CPython, wasm32-wasi, Nimbus runtime)\r\n' +
            'Type "exit()" or press Ctrl-D to exit.\r\n');
    }
    push(source) {
        const controller = new AbortController();
        const done = this.evaluate(source, controller.signal);
        const active = { controller, done };
        this.active = active;
        const clear = () => { if (this.active === active)
            this.active = null; };
        void done.then(clear, clear);
        return done;
    }
    async evaluate(source, signal) {
        const trimmed = source.trim();
        if (trimmed === 'exit' || trimmed === 'quit') {
            return { kind: 'output', stdout: '', stderr: 'Use exit() or Ctrl-D to exit\n' };
        }
        try {
            signal.throwIfAborted();
            await this.ensurePool();
            signal.throwIfAborted();
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { kind: 'error', stderr: `[python-repl] bootstrap failed: ${message}\n` };
        }
        let result;
        try {
            result = await this.submit(buildReplDriver(source), signal);
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { kind: 'error', stderr: `[python-repl] dispatch failed: ${message}\n` };
        }
        if (result.stdout.includes(INCOMPLETE_MARKER))
            return { kind: 'incomplete' };
        const exitAt = result.stdout.indexOf(EXIT_MARKER);
        if (exitAt >= 0) {
            const rest = result.stdout.slice(exitAt + EXIT_MARKER.length);
            const code = Number.parseInt(rest.slice(0, rest.indexOf(':')), 10);
            return {
                kind: 'exit',
                exitCode: Number.isFinite(code) ? code : 0,
                // Whatever the line printed before exiting is still the user's output.
                stdout: result.stdout.slice(0, exitAt),
                stderr: result.stderr,
            };
        }
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
    close() { return this.interrupt(); }
    resetPool() {
        const pool = this.pool;
        this.pool = null;
        this.wasmBytes = null;
        pool?.dispose();
    }
    async interrupt() {
        const active = this.active;
        active?.controller.abort();
        try {
            await active?.done;
        }
        finally {
            this.resetPool();
        }
    }
    async ensurePool() {
        await withHostFilesystem(this.deps.authority, CRED_KERNEL, (vfs) => this.ensurePoolFrom(vfs));
    }
    async ensurePoolFrom(vfs) {
        const sciPath = `${this.deps.installRoot}/${CPYTHON_SCI_WASM_REL}`;
        const wantsSci = (await sessionUsesSciVariant(vfs)) && (await vfs.exists(sciPath));
        // A prompt that was open before `pip install numpy` is holding the
        // interpreter that does not have it. Dropping the pool rebuilds on the next
        // statement, which is the facet restart EXTENSIONS.md says this costs.
        if (this.pool && this.poolUsesSci !== wantsSci) {
            this.resetPool();
        }
        if (this.pool)
            return;
        this.poolUsesSci = wantsSci;
        const { installRoot, facetMgr } = this.deps;
        const wasmPath = wantsSci ? sciPath : `${installRoot}/${CPYTHON_WASM_REL}`;
        const stdlibPath = `${installRoot}/${CPYTHON_STDLIB_REL}`;
        if (!(await vfs.exists(wasmPath))) {
            throw new Error(`python.wasm missing at ${wasmPath} (run 'nimbus install python')`);
        }
        if (!(await vfs.exists(stdlibPath))) {
            throw new Error(`python313.zip missing at ${stdlibPath} (run 'nimbus install python')`);
        }
        this.wasmBytes = toArrayBuffer(await vfs.readFile(wasmPath));
        this.pythonHome = `/${installRoot.replace(/^\/+/, '')}`;
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
            tag: wantsSci ? 'python-repl:sci' : 'python-repl',
            scope: crypto.randomUUID(),
            concurrency: 1,
            preamble: buildCPythonPreamble(),
            wasmModules: { 'python.wasm': this.wasmBytes },
        };
        const pid = this.deps.pid;
        this.pool = typeof pid === 'number' && pid > 0
            ? new IsolatePool(host.env, host.ctx, { ...base, supervisorPid: pid })
            // The install-time warm-up has no invoking process. It boots the
            // interpreter and never touches a file, so it asks for no supervisor
            // rather than binding one it cannot authenticate to.
            : new IsolatePool(host.env, host.ctx, { ...base, omitSupervisor: true });
    }
    active = null;
    async submit(userCode, signal) {
        const pool = this.pool;
        if (!pool)
            throw new Error('Python REPL is not initialized');
        const response = await pool.submitRequest(pythonReplStepRequestFn, new Request('https://facet.internal/python-repl-step', {
            method: 'POST',
            body: JSON.stringify({
                userCode,
                pythonHome: this.pythonHome,
                pyArgv: ['python'],
                userEnv: { HOME: '/home/user', PYTHONUNBUFFERED: '1' },
                progName: 'python',
                cwd: '/home/user',
            }),
            signal,
        }), { timeoutMs: 60_000 });
        if (!response.ok) {
            const failure = PythonFacetFailure.parse(await response.json());
            throw new Error(failure.__nimbusFacetError);
        }
        return PythonFacetResult.parse(await response.json());
    }
}
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
async function pythonReplStepRequestFn(request, facetEnv) {
    const args = await request.json();
    if (typeof args !== 'object' || args === null || !('userCode' in args) || typeof args.userCode !== 'string') {
        throw new Error('Python REPL request must contain userCode');
    }
    const run = Reflect.get(globalThis, '__cpythonReplRun');
    if (typeof run !== 'function') {
        return Response.json({
            stdout: '', stderr: '', exitCode: 127,
            error: 'cpython preamble missing: __cpythonReplRun not in scope',
        });
    }
    const adopt = Reflect.get(globalThis, '__wasiAdoptSupervisor');
    const supervisor = facetEnv && facetEnv.SUPERVISOR;
    // Published where the boot re-adopts it after the mount, because
    // __wasiInitFS clears the adoption on purpose. Omitting this here — while
    // cpython-runner's entry had it — is what made the prompt start with no
    // filesystem it could read.
    if (supervisor)
        Reflect.set(globalThis, '__nimbusPySupervisor', supervisor);
    if (typeof adopt === 'function')
        Reflect.apply(adopt, undefined, [supervisor ?? null]);
    return Response.json(await run(args));
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
