/**
 * python-runner.ts — Pyodide v0.29.4 runner (True-OS Wave-3 v2 / Pyodide v1).
 *
 * v1 scope per /workspace/.seal-internal/2026-05-10-pyodide-research/plan.md
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
export function makePythonRunnerFactory(deps: {
  facetMgr: FacetManager;
  vfs: SqliteVFS;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) =>
    (ctx: any) => Promise<number> {
  const { facetMgr, vfs } = deps;

  return function pythonRunnerFactory(manifest, installRoot, binName, _binKind) {
    const findFile = (rel: string): string | null => {
      const entry = manifest.files.find((f) => f.path === rel);
      return entry ? `${installRoot}/${entry.path}` : null;
    };
    const asmWasmVfs = findFile('share/pyodide/pyodide.asm.wasm');
    const asmJsVfs   = findFile('share/pyodide/pyodide.asm.js');
    const stdlibVfs  = findFile('share/pyodide/python_stdlib.zip');

    return async function pythonBinHandler(ctx: any): Promise<number> {
      const argv: string[] = ctx.args || [];
      const cwd: string = ctx.cwd || '/home/user';

      // ── --version / --help fast paths (no wasm boot) ─────────────
      if (argv.includes('--version') || argv.includes('-V')) {
        ctx.stdout.write(`Python 3.13.2 (Pyodide 0.29.4, Nimbus runtime)\n`);
        return 0;
      }
      if (argv.includes('--help') || argv.includes('-h')) {
        ctx.stdout.write(`usage: ${binName} [option] ... [-c cmd | -m mod | file | -] [arg] ...\n`);
        ctx.stdout.write(`Nimbus Pyodide 0.29.4 / Python 3.13 runtime.\n`);
        ctx.stdout.write(`Supported v1: -c <code>, <file.py>, stdin via -\n`);
        ctx.stdout.write(`Not supported: REPL (no args), pip, native extensions\n`);
        return 0;
      }

      // ── Resolve install bytes ────────────────────────────────────
      if (!asmWasmVfs || !vfs.exists(asmWasmVfs)) {
        ctx.stderr.write(`${binName}: pyodide.asm.wasm missing (re-run 'nimbus install python')\n`);
        return 127;
      }
      if (!asmJsVfs || !vfs.exists(asmJsVfs)) {
        ctx.stderr.write(`${binName}: pyodide.asm.js missing\n`);
        return 127;
      }
      if (!stdlibVfs || !vfs.exists(stdlibVfs)) {
        ctx.stderr.write(`${binName}: python_stdlib.zip missing\n`);
        return 127;
      }
      const asmWasmBytes = vfs.readFile(asmWasmVfs);
      const asmJsBytes   = vfs.readFile(asmJsVfs);
      const stdlibBytes  = vfs.readFile(stdlibVfs);

      // ── Parse argv ───────────────────────────────────────────────
      // Supported in v1:
      //   python -c '<code>'           run inline code, args[i+1..] in sys.argv
      //   python <file.py> [args...]   run script, args in sys.argv
      //   python                       (no args) → not supported; REPL is v2
      //   python -                     read code from stdin (advanced)
      const parsed = parsePythonArgv(argv);
      if (parsed.error) {
        ctx.stderr.write(`${binName}: ${parsed.error}\n`);
        return parsed.exitCode;
      }

      // For -c mode: code comes from argv. For script-file mode:
      // read from VFS. For stdin mode: we collect stdin upfront.
      let userCode = '';
      let progName = binName;
      let pyArgv: string[] = [binName];
      if (parsed.mode === 'inline') {
        userCode = parsed.inlineCode;
        pyArgv = ['-c', ...parsed.scriptArgs];
      } else if (parsed.mode === 'script') {
        // Read script from VFS, resolving relative to cwd.
        const absPath = resolveVfsPath(parsed.scriptPath, cwd);
        if (!vfs.exists(absPath)) {
          ctx.stderr.write(`${binName}: ${parsed.scriptPath}: No such file or directory\n`);
          return 2;
        }
        try {
          userCode = new TextDecoder('utf-8').decode(vfs.readFile(absPath));
        } catch (e: any) {
          ctx.stderr.write(`${binName}: ${parsed.scriptPath}: ${e?.message || e}\n`);
          return 1;
        }
        progName = parsed.scriptPath;
        pyArgv = [parsed.scriptPath, ...parsed.scriptArgs];
      } else if (parsed.mode === 'stdin') {
        // Read all of stdin from ctx (lifo-sh wires it when the pipe
        // is filled). Pyodide receives it as the program source.
        const stdinReader = ctx.stdin;
        if (stdinReader && typeof stdinReader.read === 'function') {
          // The shell's ctx.stdin is a stream-like with .read() that
          // returns the accumulated buffer up to EOF. Lifo-sh's pipe
          // implementation feeds the upstream's stdout into this.
          userCode = await stdinReader.read();
        } else {
          // No piped stdin → empty program.
          userCode = '';
        }
        pyArgv = ['-', ...parsed.scriptArgs];
      }

      // env passed to Python's os.environ. We forward NIMBUS_*,
      // PATH-ish, and a default HOME if not set.
      const userEnv: Record<string, string> = { ...(ctx.env || {}) };
      if (!userEnv.HOME) userEnv.HOME = '/home/pyodide';
      if (!userEnv.PYTHONUNBUFFERED) userEnv.PYTHONUNBUFFERED = '1';

      // ── Dispatch the facet ───────────────────────────────────────
      const result = await dispatchPythonFacet(facetMgr, {
        asmWasmBytes,
        asmJsBytes,
        stdlibBytes,
        userCode,
        pyArgv,
        userEnv,
        progName,
      });

      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      if (result.error) {
        ctx.stderr.write(`${binName}: ${result.error}\n`);
        return 1;
      }
      return result.exitCode;
    };
  };
}

// ── argv parser ──────────────────────────────────────────────────────

interface ParsedPyArgv {
  mode: 'inline' | 'script' | 'stdin';
  inlineCode: string;
  scriptPath: string;
  scriptArgs: string[];
  error?: string;
  exitCode: number;
}

function parsePythonArgv(argv: string[]): ParsedPyArgv {
  // Walk argv left-to-right looking for the first non-flag token OR
  // the -c / -m mode-switches. Python's CLI is more involved (-O,
  // -B, -E, -W, -I, etc.) but for v1 we accept and ignore unknown
  // single-letter flags that don't take args, and error loudly on
  // unsupported ones.
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '-c') {
      const code = argv[i + 1];
      if (code === undefined) {
        return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [], exitCode: 2,
          error: "Argument expected for the -c option" };
      }
      return {
        mode: 'inline',
        inlineCode: code,
        scriptPath: '',
        scriptArgs: argv.slice(i + 2),
        exitCode: 0,
      };
    }
    if (a === '-m') {
      const mod = argv[i + 1];
      if (mod === undefined) {
        return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [], exitCode: 2,
          error: "Argument expected for the -m option" };
      }
      // -m <mod> [args...]  →  runpy.run_module(mod)
      const inlineCode = `import runpy, sys\nsys.argv = ${JSON.stringify([mod, ...argv.slice(i + 2)])}\nrunpy.run_module(${JSON.stringify(mod)}, run_name='__main__', alter_sys=True)\n`;
      return {
        mode: 'inline',
        inlineCode,
        scriptPath: '',
        scriptArgs: argv.slice(i + 2),
        exitCode: 0,
      };
    }
    if (a === '-') {
      return { mode: 'stdin', inlineCode: '', scriptPath: '-', scriptArgs: argv.slice(i + 1), exitCode: 0 };
    }
    if (!a.startsWith('-')) {
      return {
        mode: 'script',
        inlineCode: '',
        scriptPath: a,
        scriptArgs: argv.slice(i + 1),
        exitCode: 0,
      };
    }
    // Unknown flag — for v1, silently skip single-char flags that
    // are commonly harmless (-O, -B, -u, -E, -I). Error on others.
    if (/^-[OBuEItcsx]+$/.test(a)) { i++; continue; }
    return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [], exitCode: 2,
      error: `unknown option: ${a}` };
  }
  // No mode argument provided — REPL is not supported in v1.
  return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [], exitCode: 2,
    error: "REPL not supported in v1. Use 'python -c \"code\"' or 'python script.py'." };
}

function resolveVfsPath(rel: string, cwd: string): string {
  const cwdN = cwd.replace(/^\/+/, '').replace(/\/+$/, '');
  if (rel.startsWith('/')) return rel.replace(/^\/+/, '');
  if (rel === '.') return cwdN;
  return `${cwdN}/${rel}`;
}

function uint8ToBase64(u8: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      Array.from(u8.subarray(i, Math.min(i + CHUNK, u8.length))),
    );
  }
  return btoa(s);
}

// ── Facet dispatch ───────────────────────────────────────────────────

interface PythonFacetArgs {
  asmWasmBytes: Uint8Array;
  asmJsBytes: Uint8Array;
  stdlibBytes: Uint8Array;
  userCode: string;
  pyArgv: string[];
  userEnv: Record<string, string>;
  progName: string;
}

interface PythonFacetResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

async function dispatchPythonFacet(
  facetMgr: FacetManager,
  args: PythonFacetArgs,
): Promise<PythonFacetResult> {
  const toAB = (u8: Uint8Array): ArrayBuffer =>
    u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

  // pyodide.asm.js is INLINED into the preamble (1 MiB text source).
  // Workerd's CSP allows wasm code-gen AND JS top-level evaluation at
  // module-load time, but BLOCKS `new Function(src)` at request time.
  // The asm.js source declares `var _createPyodideModule = ...` at
  // module-top; spliced into the preamble it becomes a module-scope
  // binding we expose via `globalThis._createPyodideModule = ...`
  // right after.
  //
  // stdlib.zip stays in the context (base64) — it's data not code,
  // and the context blob is evaluated at module-load too.
  let asmJsSrc = new TextDecoder('utf-8').decode(args.asmJsBytes);
  // ── Source-patch the asm.js's "Cannot determine runtime environment" branch ──
  //
  // Even with our globalThis.process / WorkerGlobalScope / self / location
  // shims in place, the asm.js's pyodide_js_init() IIFE's env-detect (via
  // bn → vn) somehow lands d.IN_BROWSER_WEB_WORKER = false at request time
  // on workerd. Our supervisor-side mirror of the same logic returns
  // IN_BROWSER_WEB_WORKER = true with the same shims; the discrepancy
  // remains unidentified after P8-P17 of diagnostic instrumentation.
  //
  // Pragmatic v1 fix: source-patch the if-chain to ALWAYS take the
  // IN_BROWSER_WEB_WORKER branch (regardless of `d`). The branch's body
  // assigns `Fe` to a globalThis.importScripts-based loadScript helper.
  // We don't actually call Fe (Pyodide only invokes loadScript when
  // dynamic-loading a wasm sibling; our instantiateWasm override pre-
  // empts that). So the patch is functionally a no-op other than making
  // the throw unreachable.
  //
  // The patch target string is a literal in the minified asm.js — stable
  // across rebuilds because it's a unique identifier path.
  const PATCH_NEEDLE = 'else throw new Error("Cannot determine runtime environment")';
  const PATCH_REPLACE = '/* nimbus-patch: was: ' + PATCH_NEEDLE + ' */';
  if (asmJsSrc.includes(PATCH_NEEDLE)) {
    asmJsSrc = asmJsSrc.replace(PATCH_NEEDLE, PATCH_REPLACE);
  }
  // Also patch the if-chain head so we ALWAYS set Fe (force-take the
  // first branch — IN_BROWSER_MAIN_THREAD's loadScript path uses
  // `await import(t)` which works in workerd at module-load time).
  // The previous patch alone is insufficient because if NO branch matches,
  // Fe stays undefined → calling it would TypeError later.
  const HEAD_NEEDLE = 'if(d.IN_BROWSER_MAIN_THREAD)';
  const HEAD_REPLACE = 'if(true||d.IN_BROWSER_MAIN_THREAD)';
  if (asmJsSrc.includes(HEAD_NEEDLE)) {
    asmJsSrc = asmJsSrc.replace(HEAD_NEEDLE, HEAD_REPLACE);
  }
  const stdlibB64 = uint8ToBase64(args.stdlibBytes);

  // Build the preamble with stdlib bytes spliced in. The preamble runs
  // the entire Pyodide bootstrap at child-facet module-init time —
  // where workerd's CSP permits `new WebAssembly.Module(rawBytes)` (the
  // convertJsFunctionToWasm code path which is the v1 hang root).
  // Per-call __pyodideRun just executes runPython on the cached
  // Pyodide instance.
  const preamble = buildPyodidePreamble(asmJsSrc, stdlibB64);

  const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
  const env = (facetMgr as any).env;
  const ctx = (facetMgr as any).ctx;
  const pool = new NimbusLoaderPool(env, ctx, {
    tag: 'python-runner',
    concurrency: 1,
    omitSupervisor: true,
    preamble,
  });

  // v2 simplification: stdlibB64 and asmWasmMod are now embedded in the
  // preamble (stdlib via base64 splice; wasm via __NIMBUS_WASM table set
  // by the loader-pool). The facet fn only needs the per-call inputs.
  const facetFn = async function pythonFacetCall(
    inArgs: {
      userCode: string;
      pyArgv: string[];
      userEnv: Record<string, string>;
      progName: string;
    },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    error?: string;
  }> {
    const fn = (globalThis as any).__pyodideRun;
    if (typeof fn !== 'function') {
      return { exitCode: 127, stdout: '', stderr: '',
        error: 'python-runner preamble missing: __pyodideRun not in scope' };
    }
    return await fn({
      userCode: inArgs.userCode,
      pyArgv: inArgs.pyArgv,
      userEnv: inArgs.userEnv,
      progName: inArgs.progName,
    });
  };

  try {
    const result: any = await pool.submit(facetFn, {
      userCode: args.userCode,
      pyArgv: args.pyArgv,
      userEnv: args.userEnv,
      progName: args.progName,
    }, {
      wasmModules: {
        'pyodide.asm.wasm': toAB(args.asmWasmBytes),
      },
      timeoutMs: 300_000,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error,
    };
  } catch (e: any) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: '',
      error: `python-runner dispatch failed: ${e?.message || e}`,
    };
  }
}

/**
 * Compose the per-call preamble by splicing the pyodide.asm.js source
 * verbatim ahead of the __pyodideRun helper. Workerd compiles this
 * blob as JS at module-load time (where `var` declarations + globals
 * assignment are allowed), then the asm.js's `var _createPyodideModule`
 * is hoisted onto globalThis.
 */
function buildPyodidePreamble(asmJsSrc: string, stdlibB64: string): string {
  return [
    '// ── Pre-asm.js environment shims ───────────────────────────────',
    '// Pyodide.asm.js detects its environment via heuristics. In',
    '// workerd, several detections fire wrong:',
    '//   - ENVIRONMENT_IS_NODE: workerd defines process + process.versions.node',
    '//     under nodejs_compat → Pyodide tries require("fs"), require("path"),',
    '//     require("crypto"), require("ws"), require("child_process"). We',
    '//     don\'t want any of those code paths because instantiateWasm is',
    '//     overridden anyway.',
    '//   - ENVIRONMENT_IS_WORKER (typeof WorkerGlobalScope !== "undefined"):',
    '//     true in workerd. Pyodide reads `self.location.href`. workerd has',
    '//     `self` (== globalThis) but `self.location` is undefined. Stub it.',
    '//   - document.currentScript?.src: workerd has no document; the',
    '//     optional-chain on undefined is fine, but we shim it explicitly',
    '//     to remove any drift across pyodide versions.',
    '//',
    '// CRITICAL: ENVIRONMENT_IS_NODE is computed inside the async-factory',
    '// returned by the asm.js IIFE — i.e., it\'s evaluated WHEN',
    '// _createPyodideModule(settings) is CALLED, not when the asm.js',
    '// module-init runs. We therefore need to keep globalThis.process =',
    '// undefined across that call, not just the asm.js inline above. The',
    '// __pyodideRun helper below does the save+restore around the call.',
    '// IMPORTANT: env-detection in asm.js happens at the IIFE OUTER scope',
    '// (runs at module-load time, during the asm.js inline below), via',
    '//   var f = oe();',
    '// `oe()` reads globalThis.process / typeof WorkerGlobalScope / typeof',
    '// self instanceof WorkerGlobalScope and stores derived flags in `f`',
    '// (captured into closure scope as `d`). Later inside the async factory',
    '// (at request time), loadScript selects on `d.IN_BROWSER_WEB_WORKER`.',
    '//',
    '// So the shims MUST be in place BEFORE the asm.js inline runs.',
    '// __pyodideRun\'s save+restore around _createPyodideModule covers the',
    '// inner async factory call BUT NOT this outer IIFE evaluation. We',
    '// therefore stub at module-load too, save the originals, and restore',
    '// AT THE END OF THE PREAMBLE (after the asm.js inline returns).',
    'const __nimbusOrigProcess = globalThis.process;',
    'const __nimbusOrigWGS = globalThis.WorkerGlobalScope;',
    'try { globalThis.process = undefined; } catch (e) { /* non-writable; fall through */ }',
    '// Defense in depth: if globalThis.process survived the = undefined',
    '// (workerd treats it as non-configurable in some setups), mark it',
    '// browser-like so Pyodide\'s `!process.browser` check fails → IN_NODE = false.',
    'try {',
    '  if (globalThis.process && typeof globalThis.process === "object") globalThis.process.browser = true;',
    '} catch (e) { /* fail-soft */ }',
    'globalThis.WorkerGlobalScope = Object;',
    'if (typeof globalThis.location !== "object" || globalThis.location === null) {',
    '  globalThis.location = { href: "pyodide://nimbus/", origin: "pyodide://nimbus", toString() { return this.href; } };',
    '}',
    'if (typeof globalThis.document === "undefined") globalThis.document = undefined;',
    'if (typeof globalThis.self === "undefined") globalThis.self = globalThis;',
    '',
    '// pyodide_js_init() inside the asm.js IIFE constructs a FinalizationRegistry',
    '// to bridge JS-side GC to Python ref-cleanup. workerd does not expose',
    '// FinalizationRegistry by default (it is gated behind the `enable_weak_ref`',
    '// compat flag, on by default after 2025-05-05). For older compat dates',
    '// the constructor is undefined and pyodide_js_init throws ReferenceError.',
    '// Provide a no-op class shim — registered callbacks are simply never',
    '// invoked. This is memory-leaky for long-lived workers (Python objects',
    '// holding JS proxies will be retained beyond their natural lifetime),',
    '// but acceptable for v1 (per-request bootstrap; workerd reaps on isolate',
    '// reuse anyway). Future v3: switch to compat_date >= 2025-05-05 and drop.',
    'if (typeof globalThis.FinalizationRegistry === "undefined") {',
    '  globalThis.FinalizationRegistry = class FinalizationRegistry {',
    '    constructor(_cleanup) {}',
    '    register(_target, _heldValue, _token) {}',
    '    unregister(_token) {}',
    '  };',
    '}',
    '',
    '// ── BEGIN: pyodide.asm.js (inlined; ~1 MiB) ─────────────────────',
    '// Module-load time evaluation. Declares `var _createPyodideModule`',
    '// at module scope; the next line hoists it onto globalThis so the',
    '// __pyodideRun helper below can reach it across slot reuses.',
    asmJsSrc,
    'if (typeof _createPyodideModule === \'function\') {',
    '  globalThis._createPyodideModule = _createPyodideModule;',
    '}',
     '// Restore originals after the asm.js IIFE outer captures env flags.',
    '// (The bootstrap promise below re-hides them inside its own async',
    '// scope so the env-detection inside the async factory body sees the',
    '// stubbed values.)',
    'try { globalThis.process = __nimbusOrigProcess; } catch (e) { /* fall through */ }',
    'try { if (globalThis.process && globalThis.process.browser === true) delete globalThis.process.browser; } catch (e) {}',
    'globalThis.WorkerGlobalScope = __nimbusOrigWGS;',
    '// ── END: pyodide.asm.js inline ──────────────────────────────────',
    '',
    buildPreambleTail(stdlibB64),
  ].join('\n');
}

// ── Facet preamble ───────────────────────────────────────────────────
//
// The preamble runs at facet module-init (workerd compiles it once
// per slot). It exposes __pyodideRun(args) on globalThis which the
// dispatched facet fn calls.
//
// Strategy mirrors Cloudflare's `python-entrypoint-helper.ts`:
//   1. Decode pyodide.asm.js bytes from context → JS source string.
//   2. new Function(asmJsSrc + '; return _createPyodideModule')()
//      — runs the Emscripten loader, returns the factory. workerd
//      allows new Function at module-init time.
//   3. Build the Emscripten settings object directly (skip the
//      public loadPyodide wrapper — we don't need its file-system
//      probing, lockfile loader, indexURL juggling). Override:
//        - instantiateWasm: feed precompiled module from __NIMBUS_WASM
//        - preRun: write python_stdlib.zip into MEMFS at /lib/python313.zip
//        - print / printErr: capture to stdout/stderr buffers
//        - onExit: capture exit code
//        - stdin: feed user input if any
//        - arguments_: sys.argv
//        - thisProgram: progName (becomes sys.argv[0])
//        - ENV: user env vars
//   4. Call _createPyodideModule(settings) → Pyodide instance
//   5. Run user code via Pyodide.runPython
//   6. Return captured stdout/stderr/exitCode

// pyodide.asm.js is inlined ABOVE this preamble by
// buildPyodidePreamble(asmJsSrc). It declares 'var
// _createPyodideModule = (() => { ... })()' at module-top and we
// hoist it onto globalThis right after the inline. By the time
// __pyodideRun is invoked at request time, globalThis._createPyodideModule
// is already populated; we never invoke `new Function` (CSP-blocked
// at request time).

// ── Preamble tail builder ─────────────────────────────────────────────
//
// Generates the preamble tail with stdlibB64 spliced as a constant so
// the bootstrap can run at child-facet module-init time (not request
// time). Module-init time is where workerd permits
// `new WebAssembly.Module(rawBytes)`, which Pyodide's
// convertJsFunctionToWasm uses to build JS-callback-to-wasm shims.
// Without module-init context, that throws CompileError and the
// bootstrap promise never resolves → workerd cancels the request as
// hung. (This v2 redesign was directly motivated by the
// /tmp/pyodide-smoketest finding — see
// /workspace/.seal-internal/2026-05-11-pyodide-v2/smoketest-result.md.)
//
// Architecture:
//
//   PREAMBLE (runs at child-facet module-init):
//   ┌─────────────────────────────────────────────────────────────┐
//   │ - env shims (FinalizationRegistry, process, WGS, location)  │
//   │ - asm.js eval (defines _createPyodideModule)                │
//   │ - stdlibB64 constant + decoded stdlibBytes                  │
//   │ - sentinel wasm module compiled                             │
//   │ - globalThis.__pyodideBootstrap = (async () => { ... })()   │
//   │     ├─ preRun: installStdlib, setHome, setEnv,              │
//   │     │           initializeNativeFS, gateRuntimeInit         │
//   │     ├─ _createPyodideModule(settings) called                │
//   │     ├─ Awaits at gate (until request time)                  │
//   │     └─ Resolves with pyodideMod after gate release          │
//   └─────────────────────────────────────────────────────────────┘
//
//   __pyodideRun(args) (runs at child-facet request handler):
//   ┌─────────────────────────────────────────────────────────────┐
//   │ - Release the bootstrap gate (crypto.getRandomValues OK now)│
//   │ - Await __pyodideBootstrap → pyodideMod                     │
//   │ - finalizeBootstrap → pyodide                               │
//   │ - runPython(userCode) → stdout/stderr/exitCode              │
//   └─────────────────────────────────────────────────────────────┘
//
function buildPreambleTail(stdlibB64: string): string {
  return `
// ── BEGIN: python-runner preamble tail (Pyodide 0.29.4, Nimbus v2) ──

// Stdlib bytes spliced into preamble at facet-build time. ~3.2 MiB
// base64 text — decoded once at module-init. Same content as
// share/pyodide/python_stdlib.zip in the runtime cache.
const __NIMBUS_STDLIB_B64 = ${JSON.stringify(stdlibB64)};

// Decode base64 → Uint8Array. Run at module-init time (synchronous).
const __nimbusStdlibBytes = (function decode(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
})(__NIMBUS_STDLIB_B64);

// Sentinel-module setup. Pyodide's pyodide.mjs compiles a tiny standalone
// wasm blob that exports {create_sentinel, is_sentinel} and attaches its
// exports as imports.sentinel BEFORE instantiating pyodide.asm.wasm. We
// bypass loadPyodide → must replicate here. The base64 blob below is
// verbatim from pyodide.mjs (variable \`G\` in v0.29.4).
const __NIMBUS_SENTINEL_WASM_B64 = 'AGFzbQEAAAABDANfAGAAAW9gAW8BfwMDAgECByECD2NyZWF0ZV9zZW50aW5lbAAAC2lzX3NlbnRpbmVsAAEKEwIHAPsBAPsbCwkAIAD7GvsUAAs=';
let __nimbusSentinelExports;
try {
  const bin = atob(__NIMBUS_SENTINEL_WASM_B64);
  const sentinelBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) sentinelBytes[i] = bin.charCodeAt(i);
  // Synchronous wasm compile at module-init (CSP permits here).
  const sentinelMod = new WebAssembly.Module(sentinelBytes);
  const sentinelInst = new WebAssembly.Instance(sentinelMod);
  __nimbusSentinelExports = sentinelInst.exports;
} catch (_e) {
  // CSP fallback — pyodide.mjs's K() also has this Symbol-based path.
  const marker = Symbol('sentinel');
  __nimbusSentinelExports = {
    create_sentinel: function() { return marker; },
    is_sentinel: function(v) { return v === marker; },
  };
}

// Module-init stdout/stderr capture buffers. Used by Pyodide's print/
// printErr (set in settings below). The per-call __pyodideRun grabs a
// slice from these buffers to isolate output per invocation.
globalThis.__nimbusPyStdout = globalThis.__nimbusPyStdout || [];
globalThis.__nimbusPyStderr = globalThis.__nimbusPyStderr || [];

// Bootstrap gate release fn — populated by gateRuntimeInit preRun hook
// during _createPyodideModule's synchronous preRun pass.
globalThis.__nimbusReleaseGate = null;

// ── Bootstrap promise (kicked off at child-facet module-init) ────────
//
// CRITICAL: this promise is created at module-init time so the
// _createPyodideModule call (and its synchronous wasm-module-compile
// side effects, including convertJsFunctionToWasm) happens in
// startup-CSP context. The promise body's awaits run as microtasks
// after module-init returns, but the SYNCHRONOUS portion of
// _createPyodideModule (wasm instantiate + preRun + reportUndefinedSymbols
// + convertJsFunctionToWasm) all completes before the first await.
//
// We hide process + WGS inside this async function so the env-detection
// inside Pyodide's async factory body sees the stubbed values, then
// restore them in the finally block.
globalThis.__pyodideBootstrap = (async function nimbusBootstrap() {
  if (typeof globalThis._createPyodideModule !== 'function') {
    return { ok: false, error: '_createPyodideModule not installed by inline asm.js' };
  }
  const __origProcess = globalThis.process;
  const __origWGS = globalThis.WorkerGlobalScope;
  try { globalThis.process = undefined; } catch {}
  try {
    if (globalThis.process && typeof globalThis.process === 'object') {
      globalThis.process.browser = true;
    }
  } catch {}
  try { globalThis.WorkerGlobalScope = Object; } catch {}

  try {
    // Get the wasm module that the loader-pool injected via __NIMBUS_WASM.
    const wasmTable = globalThis.__NIMBUS_WASM || {};
    const asmWasmMod = wasmTable['pyodide.asm.wasm'];
    if (!asmWasmMod) {
      return { ok: false, error: '__NIMBUS_WASM missing pyodide.asm.wasm' };
    }

    // Initial Pyodide config — note: args, env, progName come from the
    // per-call args at request time. We use sensible defaults here so
    // the bootstrap can complete; per-call __pyodideRun overrides via
    // M.ENV / pyodide.runPython arguments.
    const config = {
      indexURL: '/pyodide/',
      fullStdLib: false,
      jsglobals: globalThis,
      args: [],
      env: { HOME: '/home/pyodide', PYTHONINSPECT: '1' },
      packages: [],
      lockFileContents: '{"packages":{}}',
      packageCacheDir: undefined,
      enableRunUntilComplete: true,
      checkAPIVersion: false,
      _sysExecutable: 'python',
      BUILD_ID: 'nimbus-pyodide-0.29.4',
    };

    const settings = {
      noInitialRun: false,
      noExitRuntime: true,
      noImageDecoding: true,
      noAudioDecoding: true,
      noWasmDecoding: false,
      print: function(s) { globalThis.__nimbusPyStdout.push(s + '\\n'); },
      printErr: function(s) { globalThis.__nimbusPyStderr.push(s + '\\n'); },
      thisProgram: config._sysExecutable,
      arguments: config.args,
      API: { config: config, runtimeEnv: { IN_NODE: false, IN_BROWSER: false, IN_SHELL: false } },
      locateFile: function(path) { return '/pyodide/' + path; },
      instantiateWasm: function(imports, successCallback) {
        // Attach sentinel namespace synchronously — Pyodide expects
        // imports.sentinel = {create_sentinel, is_sentinel}.
        imports.sentinel = __nimbusSentinelExports;
        WebAssembly.instantiate(asmWasmMod, imports).then(function(result) {
          const inst = (result instanceof WebAssembly.Instance ? result : result.instance);
          try {
            successCallback(inst, asmWasmMod);
          } catch (cbErr) {
            globalThis.__nimbusPyStderr.push('[python-runner] receiveInstance threw: ' + (cbErr && cbErr.message) + '\\n');
            throw cbErr;
          }
        }).catch(function(e) {
          globalThis.__nimbusPyStderr.push('[python-runner] wasm instantiate failed: ' + (e && e.message) + '\\n');
        });
        return {};
      },
    };

    // Faithful replication of pyodide.mjs's
    // getFileSystemInitializationFuncs ordering, plus our request-gate.
    settings.preRun = [
      function installStdlib(M) {
        M.addRunDependency('nimbus-install-stdlib');
        try {
          const verWord = M.HEAPU32[M._Py_Version >>> 2];
          const major = (verWord >>> 24) & 0xff;
          const minor = (verWord >>> 16) & 0xff;
          M.API.pyVersionTuple = [major, minor, (verWord >>> 8) & 0xff];
          M.FS.mkdirTree('/lib');
          M.API.sitePackages = '/lib/python' + major + '.' + minor + '/site-packages';
          M.FS.mkdirTree(M.API.sitePackages);
          M.FS.writeFile('/lib/python' + major + minor + '.zip', __nimbusStdlibBytes);
        } catch (e) {
          globalThis.__nimbusPyStderr.push('[python-runner] installStdlib failed: ' + (e && e.message) + '\\n');
        } finally {
          M.removeRunDependency('nimbus-install-stdlib');
        }
      },
      function setHome(M) {
        let home = config.env.HOME;
        try { M.FS.mkdirTree(home); } catch { home = '/'; }
        try { M.FS.chdir(home); } catch {}
      },
      function setEnv(M) {
        try { Object.assign(M.ENV, config.env); } catch {}
      },
      function initializeNativeFS(M) {
        try {
          M.FS.filesystems.NATIVEFS_ASYNC = {
            mount: function() { throw new Error('NATIVEFS_ASYNC not implemented'); },
            syncfs: function(_m, _p, cb) { cb(); },
          };
        } catch {}
      },
      function gateRuntimeInit(M) {
        // Adds a runDependency that defers Pyodide's doRun (callMain →
        // CPython __wasm_call_ctors → crypto.getRandomValues — blocked
        // at module-init) until our request handler releases it.
        M.addRunDependency('nimbus-request-gate');
        globalThis.__nimbusReleaseGate = function() {
          try { M.removeRunDependency('nimbus-request-gate'); } catch {}
        };
      },
    ];

    // Stash settings on globalThis so __pyodideRun can mutate config
    // (args/env/progName) at request time before runPython.
    globalThis.__nimbusPyConfig = config;

    // Kick off _createPyodideModule. Its synchronous portion runs all
    // preRun hooks (registering the gate) and instantiates the wasm
    // module (including convertJsFunctionToWasm in
    // reportUndefinedSymbols — the v1 hang root). The returned promise
    // resolves when the gate is released at request time.
    const modPromise = globalThis._createPyodideModule(settings);
    const pyodideMod = await modPromise;
    return { ok: true, mod: pyodideMod };
  } catch (e) {
    return { ok: false, error: '_createPyodideModule failed: ' + (e && e.message), stack: e && e.stack };
  } finally {
    try { globalThis.process = __origProcess; } catch {}
    try {
      if (globalThis.process && globalThis.process.browser === true) {
        delete globalThis.process.browser;
      }
    } catch {}
    globalThis.WorkerGlobalScope = __origWGS;
  }
})();

// ── Per-call entry point ─────────────────────────────────────────────
//
// Invoked from the LOADER child facet's execute() (which calls the
// serialized facetFn that does globalThis.__pyodideRun(args)).
//
// At this point the bootstrap promise is mid-flight at the gate.
// We release the gate, await the bootstrap completion (which now
// runs CPython init in request-handler CSP context where
// crypto.getRandomValues is permitted), then finalizeBootstrap +
// runPython.
globalThis.__pyodideRun = async function __pyodideRun(args) {
  // Tracks where in the user's request output begins (the bootstrap
  // may have produced some print() output too, but in practice it
  // doesn't — CPython's Py_Initialize is silent).
  const stdoutStart = globalThis.__nimbusPyStdout.length;
  const stderrStart = globalThis.__nimbusPyStderr.length;

  // Override config args/env/progName for THIS call. The bootstrap
  // used defaults; the user's actual sys.argv and env are applied here.
  // setEnv preRun ran with the old config — we re-apply onto M.ENV
  // via runPython below.
  if (globalThis.__nimbusPyConfig) {
    globalThis.__nimbusPyConfig.args = args.pyArgv.slice(1);
    globalThis.__nimbusPyConfig.env = Object.assign({}, globalThis.__nimbusPyConfig.env, args.userEnv || {});
    globalThis.__nimbusPyConfig._sysExecutable = args.progName;
  }

  // Release the bootstrap gate (registered by gateRuntimeInit preRun).
  // Required: workerd blocks crypto.getRandomValues at module-init.
  // Releasing at request time lets Pyodide's doRun → callMain →
  // __wasm_call_ctors → randomFill run in request-handler context.
  if (typeof globalThis.__nimbusReleaseGate === 'function') {
    globalThis.__nimbusReleaseGate();
    // Make idempotent so a re-entrant call doesn't double-release.
    globalThis.__nimbusReleaseGate = function() {};
  }

  // Await bootstrap completion.
  const boot = await globalThis.__pyodideBootstrap;
  if (!boot.ok || !boot.mod) {
    return {
      exitCode: 1,
      stdout: globalThis.__nimbusPyStdout.slice(stdoutStart).join(''),
      stderr: globalThis.__nimbusPyStderr.slice(stderrStart).join(''),
      error: 'pyodide bootstrap failed: ' + (boot.error || 'unknown'),
    };
  }
  const pyodideMod = boot.mod;

  // Apply user env to MEMFS now that CPython is up. (The preRun setEnv
  // ran with bootstrap defaults; we layer the user env on top.)
  if (args.userEnv) {
    try { Object.assign(pyodideMod.ENV, args.userEnv); } catch {}
  }

  // finalizeBootstrap returns the public Pyodide JS API (the one with
  // .runPython, .globals, .registerJsModule).
  let pyodide;
  try {
    pyodide = pyodideMod.API.finalizeBootstrap(undefined, undefined);
  } catch (e) {
    return {
      exitCode: 1,
      stdout: globalThis.__nimbusPyStdout.slice(stdoutStart).join(''),
      stderr: globalThis.__nimbusPyStderr.slice(stderrStart).join(''),
      error: 'finalizeBootstrap failed: ' + (e && e.message),
    };
  }

  // Run the user code.
  let exitCode = 0;
  if (args.userCode) {
    try {
      pyodide.runPython(args.userCode);
    } catch (e) {
      if (e && typeof e.message === 'string') {
        const m = e.message.match(/^SystemExit:\\s*(-?\\d+)/m);
        if (m) {
          exitCode = parseInt(m[1], 10);
        } else if (/SystemExit/.test(e.message) && !/^SystemExit:\\s*\\S/m.test(e.message)) {
          exitCode = 0;
        } else {
          globalThis.__nimbusPyStderr.push(e.message + (e.message.endsWith('\\n') ? '' : '\\n'));
          exitCode = 1;
        }
      } else {
        globalThis.__nimbusPyStderr.push('[python-runner] unknown error: ' + e + '\\n');
        exitCode = 1;
      }
    }
  }

  return {
    exitCode: exitCode,
    stdout: globalThis.__nimbusPyStdout.slice(stdoutStart).join(''),
    stderr: globalThis.__nimbusPyStderr.slice(stderrStart).join(''),
  };
};

// ── END: python-runner preamble ───────────────────────────────────────
`;
}
