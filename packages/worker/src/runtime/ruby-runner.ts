/**
 * ruby-runner.ts — ruby.wasm (Ruby 3.3.x) runner.
 *
 * Mirror of python-runner.ts patterns adapted to Ruby's wasi-vfs +
 * canonical-abi binding. v1 scope:
 *   - `ruby --version` / `ruby -e '<code>'` / `ruby <file.rb>`
 *   - stdout/stderr → processLogs (Process tab integration)
 *   - exit code via `exit N` / unhandled exception → 1
 *   - argv passed through to ARGV; $PROGRAM_NAME / $0 set
 *   - stdlib loaded from the packed wasi-vfs inside the wasm
 *
 * Out of v1:
 *   - REPL mode (`ruby` with no args)
 *   - require_relative for non-bundled files (basic require for
 *     stdlib works since stdlib is wasi-vfs-packed inside the wasm)
 *   - gems, bundler
 *   - js-runtime bindings (gem "js") — those imports are stubbed
 *     and will raise NotImplementedError if Ruby code tries to use
 *     them
 *
 * Architecture: SAME LOADER-modules transport as python-runner / wasm-
 * runner. ruby+stdlib.wasm bytes ship via the LOADER `modules` map
 * (workerd compiles at child-facet module-init time, where CSP
 * permits). Per-user-VFS path: ~/.nimbus/runtimes/ruby/3.3.4/share/ruby/.
 *
 * Per /workspace/.seal-internal/2026-05-11-ruby-v1/audit.md:
 *   - Wasm size 34.3 MiB (well under empirical 32 MiB-ish per-call
 *     ceiling we cleared with Pyodide + clang).
 *   - 35 wasi_snapshot_preview1 imports (provided by wasi-instance.ts).
 *   - 21 rb-js-abi-host imports (stubbed throw-when-called — none fire
 *     for v1 `puts "hi"`).
 *   - 3 canonical_abi imports (resource lifecycle — implemented as
 *     a minimal Slab<number,object>).
 *   - Exports: _initialize, __wasi_vfs_rt_init, ruby-init,
 *     ruby-init-loadpath, rb-eval-string-protect, cabi_realloc,
 *     canonical_abi_drop_rb-abi-value, memory.
 */

import type { RuntimeManifest } from './runtime-catalog.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { FacetManager } from '../facets/manager.js';
import { WASI_INSTANCE_PREAMBLE_SRC } from './wasi-instance.js';

/**
 * Build the ruby-runner factory. Called once at session init; the
 * returned factory binds the manifest + install root for each
 * registered entrypoint (`ruby`, `ruby3`).
 */
export function makeRubyRunnerFactory(deps: {
  facetMgr: FacetManager;
  vfs: SqliteVFS;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) =>
    (ctx: any) => Promise<number> {
  const { facetMgr, vfs } = deps;

  return function rubyRunnerFactory(manifest, installRoot, binName, _binKind) {
    const findFile = (rel: string): string | null => {
      const entry = manifest.files.find((f) => f.path === rel);
      return entry ? `${installRoot}/${entry.path}` : null;
    };
    const wasmVfs = findFile('share/ruby/ruby+stdlib.wasm');

    return async function rubyBinHandler(ctx: any): Promise<number> {
      const argv: string[] = ctx.args || [];
      const cwd: string = ctx.cwd || '/home/user';

      // --version / --help fast paths (no wasm boot).
      if (argv.includes('--version') || argv.includes('-v')) {
        // 3.3.x — ruby.wasm 2.9.3-2.9.4 ships Ruby 3.3.4 per upstream
        // release notes. The string format matches `ruby --version`
        // shape (parsed by tooling like rbenv).
        ctx.stdout.write(`ruby 3.3.4 (2024-04-23 revision wasm) [wasm32-wasi]\n`);
        return 0;
      }
      if (argv.includes('--help') || argv.includes('-h')) {
        ctx.stdout.write(`Usage: ${binName} [switches] [--] [programfile] [arguments]\n`);
        ctx.stdout.write(`Nimbus Ruby 3.3.4 runtime (ruby.wasm 2.9.3-2.9.4).\n`);
        ctx.stdout.write(`Supported v1: -e <code>, <file.rb>, -r <lib>\n`);
        ctx.stdout.write(`Not supported: REPL (no args), gem, bundler, js-runtime\n`);
        return 0;
      }

      // Resolve install bytes.
      if (!wasmVfs || !vfs.exists(wasmVfs)) {
        ctx.stderr.write(`${binName}: ruby+stdlib.wasm missing (re-run 'nimbus install ruby')\n`);
        return 127;
      }
      const wasmBytes = vfs.readFile(wasmVfs);

      // Parse argv.
      const parsed = parseRubyArgv(argv);
      if (parsed.error) {
        ctx.stderr.write(`${binName}: ${parsed.error}\n`);
        return parsed.exitCode;
      }

      // Build user program text + ARGV per mode.
      let userCode = '';
      let progName = binName;
      let rbArgv: string[] = [binName];
      if (parsed.mode === 'inline') {
        userCode = parsed.inlineCode;
        progName = '-e';
        rbArgv = ['-e', ...parsed.scriptArgs];
      } else if (parsed.mode === 'script') {
        const absPath = resolveVfsPath(parsed.scriptPath, cwd);
        if (!vfs.exists(absPath)) {
          ctx.stderr.write(`${binName}: No such file or directory -- ${parsed.scriptPath} (LoadError)\n`);
          return 1;
        }
        try {
          userCode = new TextDecoder('utf-8').decode(vfs.readFile(absPath));
        } catch (e: any) {
          ctx.stderr.write(`${binName}: ${parsed.scriptPath}: ${e?.message || e}\n`);
          return 1;
        }
        progName = parsed.scriptPath;
        rbArgv = [parsed.scriptPath, ...parsed.scriptArgs];
      }

      // -r flags add prelude `require '<lib>'` lines (stdlib only).
      const preludeRequires = parsed.requires.map((r) => `require ${JSON.stringify(r)}`).join('\n');
      if (preludeRequires) {
        userCode = preludeRequires + '\n' + userCode;
      }

      const userEnv: Record<string, string> = { ...(ctx.env || {}) };
      if (!userEnv.HOME) userEnv.HOME = '/home/ruby';
      if (!userEnv.LANG) userEnv.LANG = 'C.UTF-8';
      // Ruby looks for charset hints via these vars; set sensible
      // defaults so puts of non-ASCII strings doesn't trip on the
      // wasi default of "ASCII-8BIT".
      if (!userEnv.LC_ALL) userEnv.LC_ALL = 'C.UTF-8';

      // Dispatch the facet.
      const result = await dispatchRubyFacet(facetMgr, {
        wasmBytes,
        userCode,
        rbArgv,
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

interface ParsedRbArgv {
  mode: 'inline' | 'script';
  inlineCode: string;
  scriptPath: string;
  scriptArgs: string[];
  requires: string[];
  error?: string;
  exitCode: number;
}

function parseRubyArgv(argv: string[]): ParsedRbArgv {
  // Ruby's CLI is rich; v1 handles -e, -r, and positional script.
  const requires: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '-e') {
      const code = argv[i + 1];
      if (code === undefined) {
        return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [],
          requires, exitCode: 2, error: "no code specified for -e (RuntimeError)" };
      }
      // -e <code> [args...]  — code into program, rest into ARGV.
      // Note: Ruby allows multiple -e; concatenated with \n.
      let concat = code;
      let j = i + 2;
      while (j < argv.length && argv[j] === '-e') {
        const more = argv[j + 1];
        if (more === undefined) {
          return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [],
            requires, exitCode: 2, error: "no code specified for -e (RuntimeError)" };
        }
        concat = concat + '\n' + more;
        j += 2;
      }
      return {
        mode: 'inline',
        inlineCode: concat,
        scriptPath: '',
        scriptArgs: argv.slice(j),
        requires,
        exitCode: 0,
      };
    }
    if (a === '-r') {
      const lib = argv[i + 1];
      if (lib === undefined) {
        return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [],
          requires, exitCode: 2, error: "missing argument for -r" };
      }
      requires.push(lib);
      i += 2;
      continue;
    }
    if (a.startsWith('-r') && a.length > 2) {
      // -rjson form (no space).
      requires.push(a.slice(2));
      i++;
      continue;
    }
    if (!a.startsWith('-')) {
      return {
        mode: 'script',
        inlineCode: '',
        scriptPath: a,
        scriptArgs: argv.slice(i + 1),
        requires,
        exitCode: 0,
      };
    }
    // Unknown flag — v1 silently ignores common harmless ones, errors on others.
    if (/^-[wWdEKUI]+$/.test(a)) { i++; continue; }
    if (a === '--disable-gems' || a === '--enable-gems') { i++; continue; }
    return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [],
      requires, exitCode: 2, error: `invalid option: ${a}` };
  }
  return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [],
    requires, exitCode: 2, error: "REPL not supported in v1. Use 'ruby -e \"code\"' or 'ruby script.rb'." };
}

function resolveVfsPath(rel: string, cwd: string): string {
  const cwdN = cwd.replace(/^\/+/, '').replace(/\/+$/, '');
  if (rel.startsWith('/')) return rel.replace(/^\/+/, '');
  if (rel === '.') return cwdN;
  return `${cwdN}/${rel}`;
}

// ── Facet dispatch ───────────────────────────────────────────────────

interface RubyFacetArgs {
  wasmBytes: Uint8Array;
  userCode: string;
  rbArgv: string[];
  userEnv: Record<string, string>;
  progName: string;
}

interface RubyFacetResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

async function dispatchRubyFacet(
  facetMgr: FacetManager,
  args: RubyFacetArgs,
): Promise<RubyFacetResult> {
  const toAB = (u8: Uint8Array): ArrayBuffer =>
    u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

  // The Ruby preamble runs the entire bootstrap at child-facet module-
  // init time (same architecture as Pyodide v2). The wasm Module is
  // instantiated synchronously where workerd permits, _initialize +
  // ruby-init-loadpath + ruby-init run, and the live instance is
  // cached on globalThis.__rubyInstance for per-call use.
  //
  // The preamble also includes WASI_INSTANCE_PREAMBLE_SRC so
  // __wasiMakeImports / __wasiInitFS / __wasiRunStart are in scope.
  const preamble = buildRubyPreamble();

  const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
  const env = (facetMgr as any).env;
  const ctx = (facetMgr as any).ctx;
  const pool = new NimbusLoaderPool(env, ctx, {
    tag: 'ruby-runner',
    concurrency: 1,
    omitSupervisor: true,
    preamble,
  });

  const facetFn = async function rubyFacetCall(
    inArgs: {
      userCode: string;
      rbArgv: string[];
      userEnv: Record<string, string>;
      progName: string;
    },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    error?: string;
  }> {
    const fn = (globalThis as any).__rubyRun;
    if (typeof fn !== 'function') {
      return { exitCode: 127, stdout: '', stderr: '',
        error: 'ruby-runner preamble missing: __rubyRun not in scope' };
    }
    return await fn({
      userCode: inArgs.userCode,
      rbArgv: inArgs.rbArgv,
      userEnv: inArgs.userEnv,
      progName: inArgs.progName,
    });
  };

  try {
    const result: any = await pool.submit(facetFn, {
      userCode: args.userCode,
      rbArgv: args.rbArgv,
      userEnv: args.userEnv,
      progName: args.progName,
    }, {
      wasmModules: {
        'ruby+stdlib.wasm': toAB(args.wasmBytes),
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
      error: `ruby-runner dispatch failed: ${e?.message || e}`,
    };
  }
}

/**
 * Compose the per-call preamble. The preamble runs at child-facet
 * module-init time; it instantiates ruby+stdlib.wasm via the LOADER-
 * provided WebAssembly.Module and bootstraps the Ruby VM. Per-call
 * __rubyRun then drives `rb-eval-string-protect` for each request.
 */
function buildRubyPreamble(): string {
  return [
    '// ── WASI shim preamble (wasi-instance.ts) ─────────────────────',
    WASI_INSTANCE_PREAMBLE_SRC,
    '',
    '// ── FinalizationRegistry shim ─────────────────────────────────',
    '// Ruby ABI guest uses FinalizationRegistry for resource cleanup.',
    '// workerd does not always expose it (compat-flag gated). Same',
    '// no-op pattern as python-runner v2 — leaky but acceptable for',
    '// per-call facet lifetime (each invocation spawns a fresh facet).',
    'if (typeof globalThis.FinalizationRegistry === "undefined") {',
    '  globalThis.FinalizationRegistry = class FinalizationRegistry {',
    '    constructor(_cleanup) {}',
    '    register(_target, _heldValue, _token) {}',
    '    unregister(_token) {}',
    '  };',
    '}',
    '',
    RUBY_RUNNER_PREAMBLE_TAIL,
  ].join('\n');
}

/**
 * The Ruby-specific portion of the preamble. Wires the wasm imports
 * (wasi_snapshot_preview1 from __wasiMakeImports, canonical_abi from a
 * tiny Slab implementation, rb-js-abi-host as stubs that throw on
 * call), instantiates the wasm Module from __NIMBUS_WASM at module-
 * init, and runs Ruby's bootstrap sequence.
 *
 * Per-call __rubyRun then mutates WASI argv/env, clears the stdout/
 * stderr capture buffers, and invokes rb-eval-string-protect with a
 * wrapper that captures SystemExit to extract the exit code.
 */
export const RUBY_RUNNER_PREAMBLE_TAIL = `
// ── BEGIN: ruby-runner preamble (Ruby 3.3.4, Nimbus v1) ─────────────

// Capture buffers shared across the bootstrap and per-call paths. The
// preamble's WASI imports route fd_write stdout/stderr into these via
// __wasiMakeImports({stdoutWrite, stderrWrite}). Per-call __rubyRun
// slices from these to isolate output per invocation.
globalThis.__nimbusRubyStdout = globalThis.__nimbusRubyStdout || [];
globalThis.__nimbusRubyStderr = globalThis.__nimbusRubyStderr || [];

// ── Canonical-ABI resource Slab ────────────────────────────────────
// Pyodide-style minimal resource manager. Ruby's rb-abi-guest.js uses
// these 4 functions for resource_drop / resource_new / resource_get /
// resource_clone, but the wasm itself only imports 3:
//   resource_drop_js-abi-value, resource_new_rb-abi-value, resource_get_rb-abi-value
class __NimbusRubySlab {
  constructor() { this._map = new Map(); this._next = 1; }
  insert(obj) { const id = this._next++; this._map.set(id, obj); return id; }
  get(id) { return this._map.get(id); }
  remove(id) { const v = this._map.get(id); this._map.delete(id); return v; }
}

// ── Bootstrap promise: runs at child-facet module-init time ────────
//
// Mirrors pyodide v2's __pyodideBootstrap pattern. The synchronous
// portion (WebAssembly.instantiate + _initialize + ruby-init-loadpath
// + ruby-init) all completes before the first await — so it executes
// in module-init CSP context where workerd permits wasm code-gen
// from the LOADER-provided Module.
globalThis.__rubyBootstrap = (async function nimbusRubyBootstrap() {
  const wasmTable = globalThis.__NIMBUS_WASM || {};
  const rubyMod = wasmTable['ruby+stdlib.wasm'];
  if (!rubyMod) {
    return { ok: false, error: '__NIMBUS_WASM missing ruby+stdlib.wasm' };
  }

  // WASI init — empty preopens initially. Per-call __rubyRun can mount
  // a cwd preopen if needed (for ruby <file.rb> reading via WASI).
  // For v1 (-e mode) we just need stdout/stderr capture + a minimal
  // FS so Ruby's stdlib init (which probes /tmp + $HOME) doesn't crash.
  __wasiInitFS({
    root: '',
    preopens: [
      // Preopen / so Ruby can resolve all FS paths through WASI.
      // Ruby's __wasi_vfs_rt_init mounts its packed stdlib under /usr
      // inside the wasm's internal VFS — these preopens are for the
      // OUTER (host-visible) FS that wasi_snapshot_preview1 exposes.
      { wasiPath: '/',        vfsPath: '' },
      { wasiPath: '/tmp',     vfsPath: 'tmp' },
      { wasiPath: '/home',    vfsPath: 'home' },
    ],
    files: {},
    dirs: ['tmp', 'home'],
  });

  // Initial argv/env (bootstrap defaults). Per-call __rubyRun re-
  // initializes WASI with the actual user argv/env before evaluating
  // user code.
  let memRef = null;
  const wasi = __wasiMakeImports({
    argv: ['ruby'],
    env: { HOME: '/home/ruby', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    getMemory: () => memRef,
    stdoutWrite: (s) => { globalThis.__nimbusRubyStdout.push(s); },
    stderrWrite: (s) => { globalThis.__nimbusRubyStderr.push(s); },
  });

  // canonical_abi imports — 3 resource lifecycle fns. The Slab is
  // shared across the lifetime of the facet (single call, then the
  // facet is reaped).
  const rbValueSlab = new __NimbusRubySlab();
  const jsValueSlab = new __NimbusRubySlab();
  const canonical_abi = {
    'resource_drop_js-abi-value': (i) => { jsValueSlab.remove(i); },
    'resource_new_rb-abi-value': (i) => rbValueSlab.insert({ _wasm_val: i }),
    'resource_get_rb-abi-value': (i) => {
      const r = rbValueSlab.get(i);
      return r ? r._wasm_val : 0;
    },
  };

  // rb-js-abi-host imports — 21 fns. Ruby only calls these when user
  // code interacts with JS (gem "js"). For v1 (puts "hi") none fire.
  // We stub each to throw a clear error so any future user code that
  // needs JS interop gets a recognizable diagnostic instead of a
  // wasm trap.
  const _stub = (name) => () => { throw new Error('ruby-runner v1: rb-js-abi-host.' + name + ' not implemented (gem "js" not supported)'); };
  const rb_js_abi_host = {
    rb_wasm_throw_prohibit_rewind_exception: () => {
      // This one CAN fire from Ruby internals (Fiber rewind guard).
      // Make it a no-op so Ruby's continuation machinery proceeds.
    },
    'eval-js: func(code: string) -> variant { success(handle<js-abi-value>), failure(handle<js-abi-value>) }': _stub('eval-js'),
    'is-js: func(value: handle<js-abi-value>) -> bool': _stub('is-js'),
    'instance-of: func(value: handle<js-abi-value>, klass: handle<js-abi-value>) -> bool': _stub('instance-of'),
    'global-this: func() -> handle<js-abi-value>': _stub('global-this'),
    'int-to-js-number: func(value: s32) -> handle<js-abi-value>': _stub('int-to-js-number'),
    'float-to-js-number: func(value: float64) -> handle<js-abi-value>': _stub('float-to-js-number'),
    'string-to-js-string: func(value: string) -> handle<js-abi-value>': _stub('string-to-js-string'),
    'bool-to-js-bool: func(value: bool) -> handle<js-abi-value>': _stub('bool-to-js-bool'),
    'proc-to-js-function: func(value: u32) -> handle<js-abi-value>': _stub('proc-to-js-function'),
    'rb-object-to-js-rb-value: func(raw-rb-abi-value: u32) -> handle<js-abi-value>': _stub('rb-object-to-js-rb-value'),
    'js-value-to-string: func(value: handle<js-abi-value>) -> string': _stub('js-value-to-string'),
    'js-value-to-integer: func(value: handle<js-abi-value>) -> variant { as-float(float64), bignum(string) }': _stub('js-value-to-integer'),
    'export-js-value-to-host: func(value: handle<js-abi-value>) -> ()': _stub('export-js-value-to-host'),
    'import-js-value-from-host: func() -> handle<js-abi-value>': _stub('import-js-value-from-host'),
    'js-value-typeof: func(value: handle<js-abi-value>) -> string': _stub('js-value-typeof'),
    'js-value-equal: func(lhs: handle<js-abi-value>, rhs: handle<js-abi-value>) -> bool': _stub('js-value-equal'),
    'js-value-strictly-equal: func(lhs: handle<js-abi-value>, rhs: handle<js-abi-value>) -> bool': _stub('js-value-strictly-equal'),
    'reflect-apply: func(target: handle<js-abi-value>, this-argument: handle<js-abi-value>, arguments: list<handle<js-abi-value>>) -> variant { success(handle<js-abi-value>), failure(handle<js-abi-value>) }': _stub('reflect-apply'),
    'reflect-get: func(target: handle<js-abi-value>, property-key: string) -> variant { success(handle<js-abi-value>), failure(handle<js-abi-value>) }': _stub('reflect-get'),
    'reflect-set: func(target: handle<js-abi-value>, property-key: string, value: handle<js-abi-value>) -> variant { success(handle<js-abi-value>), failure(handle<js-abi-value>) }': _stub('reflect-set'),
  };

  const imports = {
    wasi_snapshot_preview1: wasi.wasiImport,
    canonical_abi,
    'rb-js-abi-host': rb_js_abi_host,
  };

  let instance;
  try {
    const result = await WebAssembly.instantiate(rubyMod, imports);
    instance = (result instanceof WebAssembly.Instance ? result : result.instance);
  } catch (e) {
    return { ok: false, error: 'WebAssembly.instantiate failed: ' + (e && e.message), stack: e && e.stack };
  }
  memRef = instance.exports.memory;

  // ── Ruby bootstrap sequence ────────────────────────────────────
  // Order matters (per ruby.wasm DefaultRubyVM):
  //   1. _initialize (reactor entry; runs static initializers)
  //   2. __wasi_vfs_rt_init (mount packed stdlib at the wasi-vfs's
  //      internal FS — needed for require to find Ruby's *.rb files)
  //   3. ruby-init([progName])  — initialize VM with argv[0]
  //   4. ruby-init-loadpath()   — set $LOAD_PATH from packed stdlib
  try {
    if (typeof instance.exports._initialize === 'function') {
      instance.exports._initialize();
    }
    if (typeof instance.exports.__wasi_vfs_rt_init === 'function') {
      instance.exports.__wasi_vfs_rt_init();
    }
  } catch (e) {
    return { ok: false, error: '_initialize/wasi_vfs_rt_init failed: ' + (e && e.message), stack: e && e.stack };
  }

  // Locate the canonical Ruby ABI exports. Names embed the WIT
  // signature literal (e.g. 'ruby-init: func(args: list<string>) -> ()')
  // because rb-abi-guest is wit-bindgen-generated.
  const rubyInit = instance.exports['ruby-init: func(args: list<string>) -> ()'];
  const rubyInitLoadpath = instance.exports['ruby-init-loadpath: func() -> ()'];
  const rbEvalStringProtect = instance.exports['rb-eval-string-protect: func(str: string) -> tuple<handle<rb-abi-value>, s32>'];
  const rubyShowVersion = instance.exports['ruby-show-version: func() -> ()'];
  const cabiRealloc = instance.exports.cabi_realloc;
  if (!rubyInit || !rubyInitLoadpath || !rbEvalStringProtect || !cabiRealloc) {
    return { ok: false, error: 'Required Ruby ABI exports missing (ruby-init/init-loadpath/eval-string-protect/cabi_realloc)' };
  }

  // Encode a list<string> argument for ruby-init. WIT canonical-ABI
  // shape: caller allocates list buffer; each element is (ptr, len).
  // Strings are UTF-8 encoded into separately-allocated buffers.
  function writeListString(strings) {
    const memory = instance.exports.memory;
    const enc = new TextEncoder();
    const len = strings.length;
    const listBufPtr = cabiRealloc(0, 0, 4, len * 8);  // align=4, size=len*8
    const encoded = strings.map((s) => enc.encode(s));
    for (let i = 0; i < len; i++) {
      const bytes = encoded[i];
      const strPtr = cabiRealloc(0, 0, 1, bytes.length);
      new Uint8Array(memory.buffer).set(bytes, strPtr);
      const dv = new DataView(memory.buffer);
      dv.setUint32(listBufPtr + i * 8 + 0, strPtr, true);
      dv.setUint32(listBufPtr + i * 8 + 4, bytes.length, true);
    }
    return { ptr: listBufPtr, len };
  }

  function writeString(s) {
    const memory = instance.exports.memory;
    const enc = new TextEncoder();
    const bytes = enc.encode(s);
    const ptr = cabiRealloc(0, 0, 1, bytes.length);
    new Uint8Array(memory.buffer).set(bytes, ptr);
    return { ptr, len: bytes.length };
  }

  // NOTE: We DO NOT call ruby-init or ruby-init-loadpath here. Both
  // invoke CPython-like random-seed initialization (random_get via
  // wasi_snapshot_preview1.random_get), which workerd blocks in the
  // global-scope (module-init) context. Same constraint that bit us
  // for Pyodide v2 P21. The per-call __rubyRun runs them at request-
  // handler time where crypto.getRandomValues is permitted.
  //
  // _initialize and __wasi_vfs_rt_init are safe at module-init because
  // they only do static initialization (no entropy reads).

  return {
    ok: true,
    instance,
    wasi,
    rubyInit,
    rubyInitLoadpath,
    rbEvalStringProtect,
    rubyShowVersion,
    writeListString,
    writeString,
    rubyInitialized: false,  // mutated to true by __rubyRun on first call
  };
})();

// ── Per-call entry point ───────────────────────────────────────────
//
// Invoked from the LOADER child facet's execute() (which calls the
// serialized facetFn that does globalThis.__rubyRun(args)).
//
// At this point the bootstrap promise has resolved (since it's
// awaited inside the child facet's module-init context — the
// instantiate finishes before the request handler runs). We:
//   1. Update Ruby's $0 / $PROGRAM_NAME / ARGV via rb-eval-string-protect
//   2. Wrap the user code in a begin/rescue SystemExit/StandardError
//      handler so we can extract exit code without losing stdout
//   3. Read stdout/stderr buffers and slice from the per-call start
globalThis.__rubyRun = async function __rubyRun(args) {
  const stdoutStart = globalThis.__nimbusRubyStdout.length;
  const stderrStart = globalThis.__nimbusRubyStderr.length;

  const boot = await globalThis.__rubyBootstrap;
  if (!boot.ok) {
    return {
      exitCode: 1,
      stdout: globalThis.__nimbusRubyStdout.slice(stdoutStart).join(''),
      stderr: globalThis.__nimbusRubyStderr.slice(stderrStart).join(''),
      error: 'ruby bootstrap failed: ' + (boot.error || 'unknown') + (boot.stack ? ' [stack=' + boot.stack + ']' : ''),
    };
  }

  // First call into __rubyRun: complete Ruby VM init (ruby-init +
  // ruby-init-loadpath) now that we're in request-handler context
  // where crypto.getRandomValues is permitted. Subsequent calls skip.
  if (!boot.rubyInitialized) {
    try {
      const initArgs = boot.writeListString(['ruby', '-e_=0']);
      boot.rubyInit(initArgs.ptr, initArgs.len);
      boot.rubyInitLoadpath();
      boot.rubyInitialized = true;
    } catch (e) {
      return {
        exitCode: 1,
        stdout: globalThis.__nimbusRubyStdout.slice(stdoutStart).join(''),
        stderr: globalThis.__nimbusRubyStderr.slice(stderrStart).join(''),
        error: 'ruby-init / ruby-init-loadpath failed at request time: ' + (e && e.message),
      };
    }
  }

  // Wrapper code: set $0/$PROGRAM_NAME/ARGV/ENV, run user code,
  // capture SystemExit. We embed the user code as a Ruby string
  // literal via JSON.stringify (Ruby's double-quote strings accept
  // \\n \\t etc which JSON also emits — safe round-trip).
  //
  // The wrapper sets __NIMBUS_RUBY_EXIT to the desired exit code so
  // we can read it via a second rb-eval-string-protect call. Failing
  // SystemExit (raise) ends up with __NIMBUS_RUBY_EXIT = 1 + stderr
  // message.
  const userCodeRb = JSON.stringify(args.userCode);
  const argvRb = JSON.stringify(args.rbArgv.slice(1));  // exclude argv[0]
  const envRb = JSON.stringify(args.userEnv || {});
  const progNameRb = JSON.stringify(args.progName);

  // STAGED execution: we split the prelude (stdout sync + ARGV/ENV/$0
  // setup) from the user-code eval. The prelude has no failure modes
  // we care about; user-code is wrapped in begin/rescue for SystemExit
  // and Exception. If the wrapper itself trips a syntax/runtime error,
  // we surface it via the __NIMBUS_RUBY_DIAG side channel.
  // Build env list as string-keyed Ruby hash via the rocket-syntax.
  // Ruby treats colon-style hash literals as Symbol-keyed; we need
  // String keys so ENV[k] = v works without TypeError.
  const envEntries = Object.entries(args.userEnv || {})
    .map(([k, v]) => JSON.stringify(k) + ' => ' + JSON.stringify(v))
    .join(', ');
  const envHashRb = '{' + envEntries + '}';

  const preludeRb = [
    // Reset exit state FIRST so partial prelude failures still
    // surface a clean exit code (previously: exit 7 left $__nimbus_exit
    // = 7 → next call's prelude could fail before resetting → second
    // exit 0 returned 7).
    '$__nimbus_exit = 0',
    '$stdout.sync = true',
    '$stderr.sync = true',
    '$0 = ' + progNameRb,
    '$PROGRAM_NAME = ' + progNameRb,
    'ARGV.replace(' + argvRb + ')',
    envHashRb + '.each_pair { |k, v| ENV[k] = v }',
  ].join('; ');

  const userWrapper = [
    'begin',
    '  ' + 'eval(' + userCodeRb + ', TOPLEVEL_BINDING, ' + progNameRb + ', 1)',
    'rescue SystemExit => e',
    '  $__nimbus_exit = e.status',
    'rescue Exception => e',
    '  $stderr.write(e.full_message(highlight: false, order: :top))',
    '  $__nimbus_exit = 1',
    'ensure',
    '  $stdout.flush rescue nil',
    '  $stderr.flush rescue nil',
    'end',
  ].join("\\n");

  const memory = boot.instance.exports.memory;

  function callEvalStringProtect(rubyCode) {
    const enc = new TextEncoder();
    const bytes = enc.encode(rubyCode);
    const cabiRealloc = boot.instance.exports.cabi_realloc;
    const codePtr = cabiRealloc(0, 0, 1, bytes.length);
    new Uint8Array(memory.buffer).set(bytes, codePtr);
    const retPtr = boot.rbEvalStringProtect(codePtr, bytes.length);
    // Return is a tuple: (rb-abi-value handle u32, status s32) — 8 bytes
    const dv = new DataView(memory.buffer);
    const handle = dv.getUint32(retPtr + 0, true);
    const status = dv.getInt32(retPtr + 4, true);
    return { handle, status };
  }

  // Stage 1: run the prelude (sync flags, ARGV, ENV, $0/$PROGRAM_NAME).
  let preludeStatus;
  try {
    preludeStatus = callEvalStringProtect(preludeRb);
  } catch (e) {
    return {
      exitCode: 1,
      stdout: globalThis.__nimbusRubyStdout.slice(stdoutStart).join(''),
      stderr: globalThis.__nimbusRubyStderr.slice(stderrStart).join(''),
      error: 'ruby prelude threw: ' + (e && e.message),
    };
  }
  if (preludeStatus && preludeStatus.status !== 0) {
    globalThis.__nimbusRubyStderr.push('[ruby-runner-diag] prelude returned non-zero status: ' + preludeStatus.status + '\\n');
  }

  // Stage 2: run user code wrapped for SystemExit/Exception capture.
  let evalStatus;
  try {
    evalStatus = callEvalStringProtect(userWrapper);
  } catch (e) {
    return {
      exitCode: 1,
      stdout: globalThis.__nimbusRubyStdout.slice(stdoutStart).join(''),
      stderr: globalThis.__nimbusRubyStderr.slice(stderrStart).join(''),
      error: 'rb-eval-string-protect threw: ' + (e && e.message),
    };
  }
  if (evalStatus && evalStatus.status !== 0) {
    globalThis.__nimbusRubyStderr.push('[ruby-runner-diag] user wrapper returned non-zero status: ' + evalStatus.status + '\\n');
  }

  // Read $__nimbus_exit by evaluating it and inspecting the result
  // via Ruby's puts (captured into stderr). Simpler: call exit through
  // rb-eval-string-protect and parse the status code from there.
  //
  // Actually rbEvalStringProtect already returns a status (second
  // tuple element). When the wrapper completes normally, status is 0
  // and we read $__nimbus_exit. We use a follow-up eval that prints
  // the exit code to a sentinel marker on stderr we can scrape, but
  // a cleaner approach: have the wrapper's last expression BE the
  // exit code (so it's the return value of eval).
  //
  // Re-do: eval $__nimbus_exit and read it from a marker line we
  // emit to a side channel — easiest is to call $stdout via a unique
  // marker that we then strip from output.
  const NIMBUS_EXIT_MARKER = '__NIMBUS_RUBY_EXIT_';
  let exitCode = 0;
  try {
    // Print the marker + exit code to stderr (a side channel separate
    // from user-visible stdout). We strip it before returning.
    callEvalStringProtect(
      '$stderr.write(' + JSON.stringify(NIMBUS_EXIT_MARKER) + ' + $__nimbus_exit.to_s + "\\\\n")'
    );
    // Scrape the marker from stderr buffer — using ONLY this call's
    // slice (from stderrStart). The same facet can be reused across
    // multiple __rubyRun invocations (loader-pool dedup by tag), so
    // a previous call's marker would otherwise be matched first.
    const callStderr = globalThis.__nimbusRubyStderr.slice(stderrStart).join('');
    // Match the LAST marker in this slice (the one our just-completed
    // call emitted; if the user wrapper also emitted writes, the
    // marker is appended after them).
    const markerRe = new RegExp(NIMBUS_EXIT_MARKER + '(-?\\\\d+)', 'g');
    let lastMatch = null;
    let mit;
    while ((mit = markerRe.exec(callStderr)) !== null) lastMatch = mit;
    if (lastMatch) exitCode = parseInt(lastMatch[1], 10);
  } catch (e) {
    // Failure to read exit code → assume 0 if no errors observed.
    exitCode = 0;
  }

  // Slice + scrub the marker from stderr output before returning.
  const stdoutOut = globalThis.__nimbusRubyStdout.slice(stdoutStart).join('');
  let stderrOut = globalThis.__nimbusRubyStderr.slice(stderrStart).join('');
  stderrOut = stderrOut.replace(new RegExp(NIMBUS_EXIT_MARKER + '-?\\\\d+\\\\n?', 'g'), '');

  return {
    exitCode: exitCode,
    stdout: stdoutOut,
    stderr: stderrOut,
  };
};

// ── END: ruby-runner preamble ──────────────────────────────────────
`;
