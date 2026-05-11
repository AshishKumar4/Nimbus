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
 * Design per /workspace/.seal-internal/2026-05-11-repl-plan/plan.md §5:
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
import type { ReplAdapter, ReplPushResult } from './repl-session.js';
import { ReplSession } from './repl-session.js';
import { buildPyodidePreamble } from './python-runner.js';

/** Inputs needed to bootstrap a Pyodide REPL session. */
export interface PythonReplDeps {
  facetMgr: FacetManager;
  vfs: SqliteVFS;
  terminal: WebSocketTerminal;
  /** Per-user-VFS install dir, e.g. 'home/user/.nimbus/runtimes/python/0.29.4'. */
  installRoot: string;
}

/**
 * Adapter that owns a NimbusLoaderPool for the lifetime of the REPL
 * session. Each push(line) is a fresh pool.submit() into the cached
 * facet slot — slot reuse means globalThis state (including the
 * PyodideConsole instance bound to a persistent globals dict) survives
 * across pushes.
 */
class PythonReplAdapter implements ReplAdapter {
  private pool: any = null;  // NimbusLoaderPool (typed loosely to avoid cyclic import)
  private initDone: boolean = false;
  private deps: PythonReplDeps;

  ps1: string = '>>> ';
  ps2: string = '... ';

  constructor(deps: PythonReplDeps) {
    this.deps = deps;
  }

  banner(): string {
    return (
      'Python 3.13.2 (Pyodide 0.29.4) on Nimbus\r\n' +
      'Type "exit()" or press Ctrl-D to exit.\r\n'
    );
  }

  async push(source: string): Promise<ReplPushResult> {
    try {
      await this.ensurePool();
    } catch (e: any) {
      return { kind: 'error', stderr: `[python-repl] bootstrap failed: ${e?.message || e}\n` };
    }
    // First push initializes the PyodideConsole.
    if (!this.initDone) {
      try {
        const initResult = await this.submitFacetFn({ mode: 'init' });
        if (initResult.error) {
          return { kind: 'error', stderr: `[python-repl] console init failed: ${initResult.error}\n` };
        }
        this.initDone = true;
      } catch (e: any) {
        return { kind: 'error', stderr: `[python-repl] init dispatch failed: ${e?.message || e}\n` };
      }
    }

    let result: PythonReplFacetResult;
    try {
      result = await this.submitFacetFn({ mode: 'push', source });
    } catch (e: any) {
      return { kind: 'error', stderr: `[python-repl] push dispatch failed: ${e?.message || e}\n` };
    }

    // Map facet result → adapter result.
    if (result.exit) {
      return {
        kind: 'exit',
        exitCode: result.exitCode || 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    if (result.incomplete) {
      return { kind: 'incomplete' };
    }
    if (result.error) {
      // The error is rendered via stderr in result.stderr; surface as
      // 'output' so output framing is consistent.
      return { kind: 'output', stdout: result.stdout || '', stderr: result.stderr || '' };
    }
    return { kind: 'output', stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  async close(): Promise<void> {
    if (this.pool) {
      // NimbusLoaderPool.dispose() is synchronous (see loader-pool.ts:865);
      // the await wraps any throw without bothering the caller.
      try { this.pool.dispose?.(); } catch { /* fail-soft */ }
      this.pool = null;
    }
    this.initDone = false;
  }

  /** Build the pool once on the first push. Pulls VFS bytes for the
   *  Pyodide assets, builds the canonical preamble, creates the pool. */
  private async ensurePool(): Promise<void> {
    if (this.pool) return;
    const { vfs, installRoot, facetMgr } = this.deps;
    const wasmPath = `${installRoot}/share/pyodide/pyodide.asm.wasm`;
    const jsPath = `${installRoot}/share/pyodide/pyodide.asm.js`;
    const stdlibPath = `${installRoot}/share/pyodide/python_stdlib.zip`;
    if (!vfs.exists(wasmPath)) {
      throw new Error(`pyodide.asm.wasm missing at ${wasmPath} (run 'nimbus install python')`);
    }
    if (!vfs.exists(jsPath)) {
      throw new Error(`pyodide.asm.js missing at ${jsPath}`);
    }
    if (!vfs.exists(stdlibPath)) {
      throw new Error(`python_stdlib.zip missing at ${stdlibPath}`);
    }
    const wasmBytes = vfs.readFile(wasmPath);
    const jsBytes = vfs.readFile(jsPath);
    const stdlibBytes = vfs.readFile(stdlibPath);

    // Apply the same asm.js source-patches python-runner.ts:317-331 does.
    let asmJsSrc = new TextDecoder('utf-8').decode(jsBytes);
    const PATCH_NEEDLE = 'else throw new Error("Cannot determine runtime environment")';
    const PATCH_REPLACE = '/* nimbus-patch: was: ' + PATCH_NEEDLE + ' */';
    if (asmJsSrc.includes(PATCH_NEEDLE)) {
      asmJsSrc = asmJsSrc.replace(PATCH_NEEDLE, PATCH_REPLACE);
    }
    const HEAD_NEEDLE = 'if(d.IN_BROWSER_MAIN_THREAD)';
    const HEAD_REPLACE = 'if(true||d.IN_BROWSER_MAIN_THREAD)';
    if (asmJsSrc.includes(HEAD_NEEDLE)) {
      asmJsSrc = asmJsSrc.replace(HEAD_NEEDLE, HEAD_REPLACE);
    }

    // Encode stdlib bytes to base64 for splice into preamble.
    const stdlibB64 = uint8ToBase64(stdlibBytes);
    const preamble = buildPyodidePreamble(asmJsSrc, stdlibB64);

    // Create the pool. Tag MUST differ from 'python-runner' so REPL
    // sessions don't collide with one-shot dispatches in the loader
    // slot cache (different fnHash + different tag = separate slot).
    const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
    const env = (facetMgr as any).env;
    const ctx = (facetMgr as any).ctx;
    this.pool = new NimbusLoaderPool(env, ctx, {
      tag: 'python-repl',
      concurrency: 1,
      omitSupervisor: true,
      preamble,
    });
    // Stash the wasm bytes for first submit's wasmModules.
    (this as any).__wasmBytesAB = toAB(wasmBytes);
  }

  private async submitFacetFn(args: { mode: 'init' | 'push'; source?: string }):
      Promise<PythonReplFacetResult> {
    const wasmModules = { 'pyodide.asm.wasm': (this as any).__wasmBytesAB };
    return await this.pool.submit(replStepFacetFn, args, {
      wasmModules,
      timeoutMs: 60_000,
    });
  }
}

/** Result returned by the REPL-step facet fn. */
interface PythonReplFacetResult {
  stdout: string;
  stderr: string;
  incomplete?: boolean;
  exit?: boolean;
  exitCode?: number;
  error?: string;
}

/**
 * The facet-side function. Self-contained (no closure captures —
 * serialized via fn.toString() across the LOADER boundary).
 *
 * Modes:
 *   - 'init': bootstrap Pyodide (via __pyodideRun's preamble), import
 *     pyodide.console.PyodideConsole, store on globalThis.__pyConsole.
 *   - 'push': push args.source into __pyConsole; check syntax_check;
 *     await the future if complete; capture stdout/stderr; map
 *     SystemExit → exit:true.
 */
function replStepFacetFn(
  args: { mode: 'init' | 'push'; source?: string },
): Promise<PythonReplFacetResult> {
  // The preamble exposes globalThis.__pyodideRun (one-shot path) and
  // populates __nimbusPyodideInstance once Pyodide is finalized. We
  // first invoke __pyodideRun({userCode: ''}) for its side effect of
  // running the bootstrap + finalizeBootstrap path, then take over.
  const g: any = globalThis as any;

  return (async function () {
    // ── Init path ──
    if (args.mode === 'init') {
      // Bootstrap via the existing __pyodideRun helper. Passing an
      // empty userCode runs the full bootstrap (gate release, await
      // bootstrap promise, finalizeBootstrap, sys.argv setup) without
      // running any user code. After bootstrap, __nimbusPyodideInstance
      // is cached and we can call its runPython directly.
      if (typeof g.__pyodideRun !== 'function') {
        return {
          stdout: '',
          stderr: '',
          error: '__pyodideRun missing in preamble',
        };
      }
      const r0 = await g.__pyodideRun({
        userCode: '',
        pyArgv: ['python'],
        userEnv: { HOME: '/home/pyodide', PYTHONINSPECT: '1' },
        progName: 'python',
      });
      if (r0.error) {
        return { stdout: r0.stdout || '', stderr: r0.stderr || '', error: r0.error };
      }
      const pyodide = g.__nimbusPyodideInstance;
      if (!pyodide) {
        return { stdout: '', stderr: '', error: 'pyodide not finalized after init' };
      }
      // Create the PyodideConsole instance and stash it. We capture
      // stdout/stderr by passing explicit callbacks that forward to
      // the SAME __nimbusPyStdout / __nimbusPyStderr buffers the rest
      // of the runtime uses. PyodideConsole(persistent_stream_redirection=
      // False) means each push() temporarily redirects sys.stdout to
      // its internal capture (via redirect_stdout); we supply explicit
      // callbacks so output also reaches our JS-side buffers.
      try {
        // Expose JS-side push callbacks for Python's stdout/stderr
        // forwarding. Setting them on globalThis lets the Python
        // side reach them via the `js` module.
        g.__nimbus_repl_stdout_cb = function (s: string) { g.__nimbusPyStdout.push(s); };
        g.__nimbus_repl_stderr_cb = function (s: string) { g.__nimbusPyStderr.push(s); };
        // REPL-A2 (master plan §1 + 2026-05-11 user-evidence): the
        // PyodideConsole runsource() path swallows three things by
        // default that real CPython's REPL surfaces:
        //   1. Expression result (sys.displayhook → repr → stdout).
        //   2. Runtime exceptions (traceback.format_exception → stderr).
        //   3. SystemExit exit code (SystemExit.code → int, propagated).
        // We re-implement them Python-side inside __nimbus_repl_push,
        // which the JS host calls per submitted line. The function
        // returns a 4-tuple-like dict {status, exit_code} via globals
        // and pushes formatted text through stdout/stderr callbacks.
        pyodide.runPython([
          'import sys',
          'import io',
          'import traceback',
          'import ast',
          'import js',
          'from pyodide.console import PyodideConsole',
          // REPL-A2 (2026-05-11): PyodideConsole.runcode does
          // `from pyodide_js import loadPackagesFromImports` and awaits
          // it. In our env without the package registry initialised,
          // the call raises "TypeError: Cannot read properties of undefined
          // (reading has)" on the first 'import X' line.
          //
          // Override pyodide_js.loadPackagesFromImports with a no-op
          // async function. pyodide_js is a JsProxy for the JS-side
          // pyodide module; setattr on it writes the JS object property,
          // and PyodideConsole's import at call-time picks up the stub.
          'import pyodide_js as __nimbus_pyjs',
          'async def __nimbus_noop_loadpkgs(source): return None',
          '__nimbus_pyjs.loadPackagesFromImports = __nimbus_noop_loadpkgs',
          // Top-level globals dict — shared across all push() calls so
          // user-defined vars persist.
          '__nimbus_repl_globals = {"__name__": "__main__", "__doc__": None}',
          '__nimbus_repl_console = PyodideConsole(',
          '    __nimbus_repl_globals,',
          // The Console will call these for every write during runsource.
          '    stdout_callback=lambda s: js.__nimbus_repl_stdout_cb(s),',
          '    stderr_callback=lambda s: js.__nimbus_repl_stderr_cb(s),',
          '    persistent_stream_redirection=False,',
          ')',
          // sys.ps1/ps2 are advisory; the host renders the actual
          // prompts. Set so user code reading sys.ps1 sees sane values.
          'sys.ps1 = ">>> "',
          'sys.ps2 = "... "',
          // Source-level displayhook helper — CPython's REPL calls
          // sys.displayhook(value) on the last expression's value; if
          // value is not None, displayhook prints repr(value) + '\\n'
          // to stdout and binds builtins._ to the value. We use the
          // stdlib default sys.displayhook via direct call.
          // The 'expression result' is the value of the trailing
          // expression statement IF the source ended in one.
          //
          // PyodideConsole.push() returns a ConsoleFuture with these
          // attrs: .syntax_check ∈ {incomplete, syntax-error, complete},
          // .formatted_error (set when syntax-error). On `complete`,
          // awaiting yields the value of the last expression OR None
          // for statements. On runtime exception it raises.
          //
          // Per-push driver returns a dict for the JS host to inspect:
          //   {kind: incomplete|complete|syntax-error|exit, exit_code}
          'def __nimbus_repl_step(source):',
          '    fut = __nimbus_repl_console.push(source)',
          '    sc = fut.syntax_check',
          '    if sc == "incomplete":',
          '        return {"kind": "incomplete"}',
          '    if sc == "syntax-error":',
          // PyodideConsole already wrote formatted_error to stderr_cb;
          // verify by emitting it if formatted_error is set. Some
          // Pyodide versions only set the attribute and let the host
          // render — emit defensively (idempotent if already streamed).
          '        fe = getattr(fut, "formatted_error", None)',
          '        if fe and isinstance(fe, str):',
          '            js.__nimbus_repl_stderr_cb(fe)',
          '        return {"kind": "syntax-error"}',
          '    return {"kind": "pending", "fut": fut}',
          // Per-push complete-stage: await the future, handle SystemExit
          // + runtime exceptions + display the result.
          // REPL-A2 displayhook: PyodideConsole's async path (code.run_async
          // inside a ConsoleFuture) does NOT auto-invoke sys.displayhook
          // on the last expression value the way the CPython REPL does.
          // We replicate the displayhook behavior explicitly: if the
          // awaited result is not None, write repr(result)+"\\n" to
          // stdout_callback and bind builtins._ to the value (matches
          // CPython REPL convention where `_` holds the last result).
          //
          // Bare expressions (`a`, `1+1`, `obj.method()`) are compiled
          // in 'single' mode by PyodideConsole but the auto-displayhook
          // hook isn't wired — we wire it here. Statements (`a = 1`,
          // `def f(): ...`) return None so the displayhook is a no-op.
          'import builtins as __nimbus_builtins',
          'async def __nimbus_repl_finish(fut):',
          '    try:',
          '        result = await fut',
          '        if result is not None:',
          '            try:',
          '                rendered = repr(result)',
          '            except BaseException as re:',
          '                rendered = "<repr() failed: " + repr(re) + ">"',
          '            js.__nimbus_repl_stdout_cb(rendered + "\\n")',
          '            __nimbus_builtins._ = result',
          '    except SystemExit as se:',
          '        code = se.code',
          '        if code is None:',
          '            n = 0',
          '        elif isinstance(code, int):',
          '            n = code',
          '        else:',
          // Real CPython exits with 1 on string arg + prints msg to stderr.
          '            js.__nimbus_repl_stderr_cb(str(code) + "\\n")',
          '            n = 1',
          '        return {"kind": "exit", "exit_code": n}',
          '    except BaseException as e:',
          // Runtime exception (NameError, TypeError, etc.). Format the
          // traceback the way CPython's REPL does: traceback.format_exception
          // returns a list of strings; join them and emit to stderr_cb.
          // We omit the top frame (the REPL driver itself) by limiting
          // to the user's frame chain — CPython's interactive interpreter
          // strips its own frame via tb.tb_next.
          '        tb = e.__traceback__',
          '        if tb is not None:',
          '            tb = tb.tb_next  # skip __nimbus_repl_finish frame',
          '        lines = traceback.format_exception(type(e), e, tb)',
          '        js.__nimbus_repl_stderr_cb("".join(lines))',
          '        return {"kind": "error"}',
          // No exception → result is the expression value (or None for
          // statements). PyodideConsole's runsource compiles in
          // "single" mode which already invokes sys.displayhook for
          // expression statements. So `a` at the REPL → displayhook',
          // already wrote repr(a)+"\\n" to stdout BEFORE we got here.',
          // We deliberately do NOT double-print result. CPython 3.13 +,
          // PyodideConsole behaviour validated: stdout_callback received
          // the displayhook output mid-await.
          '    return {"kind": "complete"}',
        ].join('\n'));
      } catch (e) {
        return {
          stdout: '',
          stderr: '',
          error: 'PyodideConsole init failed: ' + ((e as any)?.message || e),
        };
      }
      return { stdout: '', stderr: '' };
    }

    // ── Push path ──
    const pyodide = g.__nimbusPyodideInstance;
    if (!pyodide) {
      return { stdout: '', stderr: '', error: 'pyodide not initialized (init mode not run)' };
    }
    const source = args.source || '';
    // Reset capture buffer offsets.
    const stdoutStart = g.__nimbusPyStdout.length;
    const stderrStart = g.__nimbusPyStderr.length;
    // REPL-A2: source-routing via Python-side global to avoid JS-string
    // escape hazards on multi-line input (tab chars, embedded quotes,
    // unicode). __nimbus_repl_step inspects syntax_check and either
    // returns {kind: incomplete|syntax-error} OR returns a pending dict
    // containing the future to await.
    g.__nimbus_repl_src = source;
    let stepRes: any;
    try {
      stepRes = pyodide.runPython(
        '__nimbus_repl_step(__import__("js").__nimbus_repl_src)',
      );
    } catch (e: any) {
      // PyodideConsole.push() itself threw — extremely rare (means the
      // tokenizer crashed). Surface as error.
      return {
        stdout: g.__nimbusPyStdout.slice(stdoutStart).join(''),
        stderr: 'push threw: ' + (e?.message || e) + '\n',
      };
    }
    // PyProxy → JS object. Convert via toJs (depth=1 to keep `fut`
    // as PyProxy). Pyodide's PyProxy.toJs({depth:1}) returns a Map by
    // default; pass dict_converter to get a plain object.
    let kind: string;
    let futProxy: any = null;
    try {
      const asJs = stepRes.toJs({
        depth: 1,
        dict_converter: Object.fromEntries,
      });
      kind = asJs.kind;
      futProxy = asJs.fut;
    } catch (_e) {
      // Fallback: access via getattr.
      kind = stepRes.get('kind');
      futProxy = stepRes.get('fut');
    } finally {
      try { stepRes.destroy(); } catch {}
    }

    if (kind === 'incomplete') {
      return {
        stdout: g.__nimbusPyStdout.slice(stdoutStart).join(''),
        stderr: g.__nimbusPyStderr.slice(stderrStart).join(''),
        incomplete: true,
      };
    }

    if (kind === 'syntax-error') {
      return {
        stdout: g.__nimbusPyStdout.slice(stdoutStart).join(''),
        stderr: g.__nimbusPyStderr.slice(stderrStart).join(''),
      };
    }

    // kind === 'pending' — await Python-side __nimbus_repl_finish(fut).
    // This Python coroutine handles SystemExit, runtime exceptions, and
    // the displayhook side-effect (stdout already streamed mid-await).
    //
    // We pass the future across the JS↔Py boundary via a JS-side global:
    // Pyodide's runPythonAsync doesn't take positional args, so stash
    // `futProxy` on globalThis under a stable name and have Python read
    // it via `__import__("js").__nimbus_repl_fut`.
    g.__nimbus_repl_fut = futProxy;
    let finishRes: any;
    try {
      // pyodide.runPythonAsync returns a Promise resolving to the
      // coroutine's return value (a PyProxy dict).
      finishRes = await pyodide.runPythonAsync(
        'await __nimbus_repl_finish(__import__("js").__nimbus_repl_fut)',
      );
    } catch (e: any) {
      // __nimbus_repl_finish has its own try/except for SystemExit and
      // BaseException — reaching here means the dispatch itself broke.
      try { futProxy?.destroy?.(); } catch {}
      return {
        stdout: g.__nimbusPyStdout.slice(stdoutStart).join(''),
        stderr: 'repl-finish threw: ' + (e?.message || e) + '\n',
      };
    }
    let finishKind: string = 'complete';
    let exitCode: number = 0;
    try {
      const asJs = finishRes.toJs({
        depth: 1,
        dict_converter: Object.fromEntries,
      });
      finishKind = asJs.kind || 'complete';
      exitCode = typeof asJs.exit_code === 'number' ? asJs.exit_code : 0;
    } catch (_e) {
      try {
        finishKind = finishRes.get('kind') || 'complete';
        exitCode = finishRes.get('exit_code') || 0;
      } catch {}
    } finally {
      try { finishRes.destroy(); } catch {}
      try { futProxy?.destroy?.(); } catch {}
    }

    if (finishKind === 'exit') {
      return {
        stdout: g.__nimbusPyStdout.slice(stdoutStart).join(''),
        stderr: g.__nimbusPyStderr.slice(stderrStart).join(''),
        exit: true,
        exitCode: exitCode,
      };
    }
    // 'complete' or 'error' — both render via stdout/stderr buffers.
    return {
      stdout: g.__nimbusPyStdout.slice(stdoutStart).join(''),
      stderr: g.__nimbusPyStderr.slice(stderrStart).join(''),
    };
  })();
}

/** ArrayBuffer view of a Uint8Array, without copy. */
function toAB(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/** Encode Uint8Array → base64 in chunks to avoid stack overflow on
 *  ~2 MiB stdlib payload. Mirrors python-runner.ts's helper. */
function uint8ToBase64(u8: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      Array.from(u8.subarray(i, Math.min(i + CHUNK, u8.length))) as any,
    );
  }
  return btoa(s);
}

/**
 * Top-level wrapper: builds a Python REPL adapter, drives a
 * ReplSession to completion, returns the exit code.
 *
 * Called from the python factory's wrapper in init.ts when the user
 * runs `python` with no args.
 */
export async function runPythonRepl(deps: PythonReplDeps): Promise<number> {
  const adapter = new PythonReplAdapter(deps);
  const session = new ReplSession(adapter, deps.terminal);
  return await session.run();
}
