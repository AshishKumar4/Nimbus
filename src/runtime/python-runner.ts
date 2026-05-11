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
  const asmJsSrc = new TextDecoder('utf-8').decode(args.asmJsBytes);
  const stdlibB64 = uint8ToBase64(args.stdlibBytes);

  const preamble = buildPyodidePreamble(asmJsSrc);

  const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
  const env = (facetMgr as any).env;
  const ctx = (facetMgr as any).ctx;
  const pool = new NimbusLoaderPool(env, ctx, {
    tag: 'python-runner',
    concurrency: 1,
    omitSupervisor: true,
    preamble,
  });

  const facetFn = async function pythonFacetCall(
    inArgs: {
      stdlibB64: string;
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
    const wasmTable = (globalThis as any).__NIMBUS_WASM || {};
    const asmWasmMod = wasmTable['pyodide.asm.wasm'];
    if (!asmWasmMod) {
      return { exitCode: 127, stdout: '', stderr: '',
        error: 'python-runner: __NIMBUS_WASM missing pyodide.asm.wasm' };
    }
    const fn = (globalThis as any).__pyodideRun;
    if (typeof fn !== 'function') {
      return { exitCode: 127, stdout: '', stderr: '',
        error: 'python-runner preamble missing: __pyodideRun not in scope' };
    }
    return await fn({
      stdlibB64: inArgs.stdlibB64,
      userCode: inArgs.userCode,
      pyArgv: inArgs.pyArgv,
      userEnv: inArgs.userEnv,
      progName: inArgs.progName,
      asmWasmMod,
    });
  };

  try {
    const result: any = await pool.submit(facetFn, {
      stdlibB64,
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
function buildPyodidePreamble(asmJsSrc: string): string {
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
    '// ── BEGIN: pyodide.asm.js (inlined; ~1 MiB) ─────────────────────',
    '// Module-load time evaluation. Declares `var _createPyodideModule`',
    '// at module scope; the next line hoists it onto globalThis so the',
    '// __pyodideRun helper below can reach it across slot reuses.',
    asmJsSrc,
    'if (typeof _createPyodideModule === \'function\') {',
    '  globalThis._createPyodideModule = _createPyodideModule;',
    '}',
    '// Restore originals after the asm.js IIFE outer captures env flags.',
    '// The async-factory body re-reads process at runtime for IN_NODE, so',
    '// __pyodideRun also hides+restores process around the factory call.',
    'try { globalThis.process = __nimbusOrigProcess; } catch (e) { /* fall through */ }',
    'try { if (globalThis.process && globalThis.process.browser === true) delete globalThis.process.browser; } catch (e) {}',
    'globalThis.WorkerGlobalScope = __nimbusOrigWGS;',
    '// ── END: pyodide.asm.js inline ──────────────────────────────────',
    '',
    PYTHON_RUNNER_PREAMBLE_TAIL,
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

export const PYTHON_RUNNER_PREAMBLE_TAIL = `
// ── BEGIN: python-runner preamble (Pyodide 0.29.4, Nimbus v1) ──────

globalThis.__pyodideRun = async function __pyodideRun(args) {
  const stdoutChunks = [];
  const stderrChunks = [];
  let exitCode = 0;

  if (typeof globalThis._createPyodideModule !== 'function') {
    return { exitCode: 1, stdout: '', stderr: '',
      error: 'globalThis._createPyodideModule not installed by inline asm.js' };
  }

  // ── Step 1: build the Emscripten settings object. ──────────────
  // We bypass loadPyodide() and call _createPyodideModule directly
  // with the settings we need. This avoids the public loader's
  // file-system probing (which expects Node fs or browser URL
  // resolution — workerd has neither).
  const stdlibBytes = (function decode(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  })(args.stdlibB64);

  // The Pyodide config object. Mirror the shape that loadPyodide()
  // builds internally (pyodide.mjs:initializeConfiguration +
  // createSettings):
  const config = {
    indexURL: '/pyodide/',
    fullStdLib: false,
    args: args.pyArgv.slice(1),  // sys.argv excluding argv[0]; thisProgram fills argv[0]
    env: args.userEnv,
    packages: [],
    lockFileContents: '{"packages":{}}',
    _sysExecutable: args.progName,
    BUILD_ID: 'nimbus-pyodide-0.29.4',
  };
  if (!config.env.HOME) config.env.HOME = '/home/pyodide';

  // ── Pyodide's createSettings shape. We replicate the relevant
  //    bits inline because importing pyodide.mjs would re-trigger the
  //    node:fs probe path. ──
  const settings = {
    noImageDecoding: true,
    noAudioDecoding: true,
    noWasmDecoding: false,
    print: (s) => { stdoutChunks.push(s + '\\n'); },
    printErr: (s) => { stderrChunks.push(s + '\\n'); },
    onExit: (code) => { exitCode = code | 0; },
    thisProgram: config._sysExecutable,
    arguments: config.args,
    API: { config, runtimeEnv: { IN_NODE: false, IN_BROWSER: false, IN_SHELL: false } },
    locateFile: (path) => '/pyodide/' + path,
    // Override instantiateWasm to pull the precompiled module from
    // __NIMBUS_WASM (set by the loader-pool's modules-map entry).
    // The single-arg WebAssembly.instantiate(Module, imports) form
    // is the only one workerd CSP allows at request time.
    instantiateWasm: function(imports, successCallback) {
      const mod = args.asmWasmMod;
      WebAssembly.instantiate(mod, imports).then((result) => {
        const inst = (result instanceof WebAssembly.Instance ? result : result.instance);
        successCallback(inst, mod);
      }).catch((e) => {
        stderrChunks.push('[python-runner] wasm instantiate failed: ' + (e && e.message) + '\\n');
        exitCode = 1;
      });
      // Per Emscripten contract: return {} from instantiateWasm to
      // indicate async completion (the actual instance is delivered
      // via successCallback above).
      return {};
    },
  };

  // ── preRun: install the stdlib zip into MEMFS at /lib/python313.zip ──
  //
  // Pyodide's pyodide.mjs:getFileSystemInitializationFuncs spins up
  // installStdlib(stdLibURL) which does loadBinaryFile(URL). That
  // tries to fetch over the network — blocked in workerd at request
  // time. Instead we write the bytes directly via FS in preRun.
  settings.preRun = [
    function installStdlib(M) {
      M.addRunDependency('nimbus-install-stdlib');
      try {
        // CPython version: from Pyodide's _Py_Version macro = 0x030D0200
        // → Python 3.13.2.
        const major = 3, minor = 13;
        M.FS.mkdirTree('/lib');
        M.API.sitePackages = '/lib/python' + major + '.' + minor + '/site-packages';
        M.FS.mkdirTree(M.API.sitePackages);
        M.FS.writeFile('/lib/python' + major + minor + '.zip', stdlibBytes, { canOwn: true });
      } catch (e) {
        stderrChunks.push('[python-runner] installStdlib failed: ' + (e && e.message) + '\\n');
      } finally {
        M.removeRunDependency('nimbus-install-stdlib');
      }
    },
    function setHome(M) {
      try { M.FS.mkdirTree(config.env.HOME); M.FS.chdir(config.env.HOME); } catch (e) { /* fail-soft */ }
    },
    function setEnv(M) {
      try { Object.assign(M.ENV, config.env); } catch (e) { /* fail-soft */ }
    },
  ];

  // ── Step 2: instantiate Pyodide. ───────────────────────────────
  // Hide globalThis.process for the duration of _createPyodideModule
  // — Pyodide's ENVIRONMENT_IS_NODE detection evaluates here (in the
  // async-factory body, NOT in the IIFE outer scope), and a truthy
  // process triggers require('fs'). After the factory returns,
  // ENVIRONMENT_IS_NODE has been captured into module-init lexical
  // scope so we can restore process.
  // ── DIAG: log env state at request time. Temporary; remove after green.
  try {
    stderrChunks.push('[diag] process=' + typeof globalThis.process
      + ' .browser=' + (globalThis.process && globalThis.process.browser)
      + ' .versions.node=' + (globalThis.process && globalThis.process.versions && globalThis.process.versions.node)
      + ' WGS=' + typeof globalThis.WorkerGlobalScope
      + ' self=' + typeof globalThis.self
      + ' selfInstanceObj=' + (globalThis.self instanceof Object)
      + ' location=' + typeof globalThis.location
      + ' window=' + typeof globalThis.window
      + ' Bun=' + typeof globalThis.Bun
      + ' Deno=' + typeof globalThis.Deno
      + '\\n');
  } catch (e) { stderrChunks.push('[diag] err: ' + (e && e.message) + '\\n'); }
  const __origProcess = globalThis.process;
  const __origWGS = globalThis.WorkerGlobalScope;
  // Some JS hosts (workerd among them) treat \`process\` as a non-
  // configurable global that .delete() / = undefined silently fail
  // for. Two safety nets:
  //   1. Try the simple = undefined.
  //   2. Also patch process.versions.node to "" — Pyodide's IN_NODE
  //      check requires \`typeof process.versions.node === "string" &&\`
  //      AND \`!process.browser\`. We can't reach negative-from-truthy
  //      via versions but we can make .node be empty string ("" is a
  //      string so condition holds), then also set .browser = true so
  //      the negation \`!process.browser\` = false → IN_NODE = false.
  //      That sidesteps any global-protection.
  try {
    globalThis.process = undefined;
  } catch { /* non-writable; fall through to patch route */ }
  try {
    if (globalThis.process && typeof globalThis.process === 'object') {
      // Mark this process object as a browser-like environment so
      // Pyodide treats us as non-Node. Pyodide checks: typeof process
      // === 'object' && typeof process.versions === 'object' && typeof
      // process.versions.node === 'string' && !process.browser.
      globalThis.process.browser = true;
    }
  } catch { /* fall through */ }
  globalThis.WorkerGlobalScope = Object;
  let pyodideMod;
  try {
    pyodideMod = await globalThis._createPyodideModule(settings);
    if (settings.exitCode !== undefined && settings.exitCode !== 0) {
      throw new pyodideMod.ExitStatus(settings.exitCode);
    }
  } catch (e) {
    globalThis.process = __origProcess;
    globalThis.WorkerGlobalScope = __origWGS;
    // Emscripten throws ExitStatus on sys.exit / proc_exit.
    if (e && e.name === 'ExitStatus') {
      exitCode = e.status | 0;
      return {
        exitCode,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
      };
    }
    return {
      exitCode: 1,
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
      error: '_createPyodideModule failed: ' + (e && e.message),
    };
  }
  // Restore process + WorkerGlobalScope on the success path.
  globalThis.process = __origProcess;
  globalThis.WorkerGlobalScope = __origWGS;

  // ── Step 3: bootstrap CPython interpreter. ─────────────────────
  //
  // pyodide.mjs:bootstrapPyodide calls finalizeBootstrap which sets
  // up sys.path, the exception handlers, and the runPython helper.
  // We can't call loadPyodide; we replicate just the runPython
  // entry by going through Pyodide's exported _Py_RunMain or
  // PyRun_SimpleString. Easier: use Pyodide's high-level API via
  // pyodideMod.API.finalizeBootstrap, then pyodideMod.runPython.
  let pyodide;
  try {
    // finalizeBootstrap returns the public Pyodide JS API object
    // (the one with .runPython, .globals, .registerJsModule).
    pyodide = pyodideMod.API.finalizeBootstrap(undefined, undefined);
  } catch (e) {
    return {
      exitCode: 1,
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
      error: 'finalizeBootstrap failed: ' + (e && e.message),
    };
  }

  // ── Step 4: run the user code. ─────────────────────────────────
  if (args.userCode) {
    try {
      // pyodide.runPython runs the source as if it were a module-
      // top-level program. Exceptions are caught and re-raised as
      // PythonError on the JS side.
      pyodide.runPython(args.userCode);
    } catch (e) {
      // Python exceptions are PythonError; sys.exit raises SystemExit
      // which pyodide surfaces as an exit code on the message.
      if (e && typeof e.message === 'string') {
        // Try to detect SystemExit and parse its exit code.
        const m = e.message.match(/^SystemExit:\\s*(-?\\d+)/m);
        if (m) {
          exitCode = parseInt(m[1], 10);
        } else if (/SystemExit/.test(e.message) && !/^SystemExit:\\s*\\S/m.test(e.message)) {
          // SystemExit with no arg → exit 0
          exitCode = 0;
        } else {
          stderrChunks.push(e.message + (e.message.endsWith('\\n') ? '' : '\\n'));
          exitCode = 1;
        }
      } else {
        stderrChunks.push('[python-runner] unknown error: ' + e + '\\n');
        exitCode = 1;
      }
    }
  }

  return {
    exitCode,
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
  };
};

// ── END: python-runner preamble ───────────────────────────────────────
`;
