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
      // running any user code. After this, __nimbusPyodideInstance is
      // cached and we can call its runPython directly.
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
        pyodide.runPython([
          'import sys',
          'import js',
          'from pyodide.console import PyodideConsole',
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
    // Push the source. PyodideConsole.push returns a ConsoleFuture
    // whose `syntax_check` attribute is 'incomplete' | 'syntax-error'
    // | 'complete'. For 'complete' we await the future to get the
    // result; for 'incomplete' we signal the host to render ... and
    // accumulate; for 'syntax-error' the error is already written to
    // stderr by the Console and we render the next prompt.
    //
    // Set the source via a Python-side global to avoid JS-side escape
    // hazards on multi-line user input.
    g.__nimbus_repl_src = source;
    let pushFuture: any;
    let syntaxCheck: string = 'unknown';
    try {
      pushFuture = pyodide.runPython([
        '__nimbus_repl_future = __nimbus_repl_console.push(' +
          '__import__("js").__nimbus_repl_src)',
        '__nimbus_repl_future',
      ].join('\n'));
      syntaxCheck = pushFuture.syntax_check;
    } catch (e: any) {
      return {
        stdout: g.__nimbusPyStdout.slice(stdoutStart).join(''),
        stderr: 'push threw: ' + (e?.message || e) + '\n',
      };
    }

    if (syntaxCheck === 'incomplete') {
      try { pushFuture.destroy(); } catch {}
      return {
        stdout: g.__nimbusPyStdout.slice(stdoutStart).join(''),
        stderr: g.__nimbusPyStderr.slice(stderrStart).join(''),
        incomplete: true,
      };
    }

    if (syntaxCheck === 'syntax-error') {
      try { pushFuture.destroy(); } catch {}
      return {
        stdout: g.__nimbusPyStdout.slice(stdoutStart).join(''),
        stderr: g.__nimbusPyStderr.slice(stderrStart).join(''),
      };
    }

    // 'complete' — await the future for the result.
    try {
      // ConsoleFuture is an asyncio.Future-like Python object; JS-side
      // it's a JsProxy. Await converts to JS Promise.
      await pushFuture;
      try { pushFuture.destroy(); } catch {}
    } catch (e: any) {
      try { pushFuture.destroy(); } catch {}
      // Check for SystemExit (typed via the PyodideConsole's exc.cause).
      const msg = e?.message || String(e);
      if (/SystemExit/.test(msg)) {
        const m = msg.match(/SystemExit:?\s*(-?\d+)?/);
        const code = m && m[1] ? parseInt(m[1], 10) : 0;
        return {
          stdout: g.__nimbusPyStdout.slice(stdoutStart).join(''),
          stderr: g.__nimbusPyStderr.slice(stderrStart).join(''),
          exit: true,
          exitCode: code,
        };
      }
      // Non-SystemExit: Python error rendered via traceback to stderr.
      return {
        stdout: g.__nimbusPyStdout.slice(stdoutStart).join(''),
        stderr: g.__nimbusPyStderr.slice(stderrStart).join(''),
      };
    }

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
