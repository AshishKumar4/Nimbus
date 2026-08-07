/**
 * wasm-runner.ts — native-WASM runner via the LOADER-modules transport.
 *
 * Direct `WebAssembly.instantiate(bytes)` is blocked by workerd CSP at
 * request time in both the supervisor and facet isolates. This runner routes
 * through the LOADER modules map:
 * bytes ride INSIDE the worker code blob, workerd compiles them
 * during the inner worker's MODULE-LOAD phase (the one phase where
 * wasm code generation IS allowed), and the resulting
 * WebAssembly.Module is exposed to the user fn via the
 * NimbusLoaderPool's `globalThis.__NIMBUS_WASM[<name>]` table.
 *
 * Shell command shape
 * ───────────────────
 *
 *   wasm-runner --version
 *   wasm-runner <file.wasm> <exportName> [int args...]
 *
 * Each invocation:
 *   1. Reads bytes from VFS (or any caller-supplied source).
 *   2. Allocates a PID via the process supervisor (Process tab integration).
 *   3. NimbusLoaderPool.submit() with wasmModules: { 'user.wasm': bytes }
 *      — pool merges per-call wasm with constructor-time entries,
 *      generates a worker.js that imports './user.wasm', and ships
 *      the modules map to env.LOADER.get(...).
 *   4. The submitted fn runs inside the inner facet:
 *      - reads globalThis.__NIMBUS_WASM['user.wasm'] (the precompiled
 *        Module the pool registered)
 *      - WebAssembly.instantiate(module, {}) — allowed because the
 *        Module is precompiled
 *      - looks up the export, calls with parsed integer args, returns
 *        the result + the export list
 *   5. Supervisor formats and writes stdout/stderr; exit code 0/1.
 *
 * Limitations (documented in --help):
 *   - Function args are integers only (parseInt). Float / string /
 *     multi-arg-shapes need a wrapper module.
 *   - Only WebAssembly.Memory and integer return values are surfaced.
 *   - WASI imports are NOT provided. Modules expecting wasi_snapshot
 *     won't instantiate (fail at the in-facet instantiate step).
 *
 * Dispatch constraints
 * ────────────────────
 *   - No sleeps, caller-side retries, or catch-and-continue around loader
 *     failures. The pool's resilience options own retry behavior.
 *   - The try/catch around vfs.readFile is a legitimate I/O boundary;
 *     the diagnostic propagates as exitCode 1 + stderr line.
 *   - NO direct WebAssembly.instantiate(bytes) at request time —
 *     workerd CSP rejects that path.
 */

import type { RuntimeRunOpts, RuntimeRunResult } from './runtime-registry.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { requireVfsCred, WASM32_WASI_NIMBUS_ABI } from './os-contracts.js';
import { WASI_INSTANCE_PREAMBLE_SRC, WASI_IMPLEMENTED_FNS, WASI_ABI_NAMESPACE } from './wasi-instance.js';
import type { WasiInitOptions, WasiInstanceBundle, WasiMakeImportsOptions } from './wasi/types.js';
import type { WasiAbi } from './wasi-instance.js';
import { inspectWasmThreads, wasiThreadsLoadError } from './wasi-threads.js';
import { manifestVfs } from './vfs-manifest.js';
import { withMemoryLimit, DEFAULT_WASM_PROCESS_LIMIT_BYTES } from './wasm-memory.js';

// ── facet-side globals injected by the WASI preamble ─────────────────
// The preamble (WASI_INSTANCE_PREAMBLE_SRC) runs at facet module-init
// time and declares these top-level. The facet fn below references
// them; tsc needs to know they exist. Empty bodies — only types.
//
// The SHAPES come from runtime/wasi/types.ts, which is what the shim itself is
// written against. They used to be restated here by hand, and the copy had
// drifted: it omitted `parking` entirely and declared `getMemory` as returning a
// nullable memory, which the shim dereferences unguarded. A second description
// of one contract cannot be kept honest, so there is now only the one.
declare const __wasiMakeImports: (opts: WasiMakeImportsOptions) => WasiInstanceBundle;
declare const __wasiInitFS: (opts: WasiInitOptions) => void;
declare const __wasiAdoptSupervisor: (sup: unknown) => void;
declare const __wasiDrainPersist: () => Promise<void>;
/** The green-thread scheduler — see runtime/wasi-threads.ts. */
interface WasiThreadScheduler {
  hostImports: () => Record<string, WebAssembly.ModuleImports>;
}
declare const __wasiThreadsCreate: (opts: {
  memory: WebAssembly.Memory;
  startThread: (tid: number, startArg: number) => () => Promise<unknown>;
}) => WasiThreadScheduler;
declare const __wasiThreadsStarter: (
  module: WebAssembly.Module,
  importObject: Record<string, WebAssembly.ModuleImports>,
) => (tid: number, startArg: number) => () => Promise<unknown>;
declare const __wasiRunStartThreads: (
  instance: WebAssembly.Instance,
  sched: WasiThreadScheduler,
) => Promise<{ exitCode: number; error?: string }>;
declare const __wasiRunStart: (
  instance: WebAssembly.Instance,
  ctx: { memory: WebAssembly.Memory },
) => { exitCode: number; error?: string };
// WASI socket and polling support P3: async variant that wraps _start with WebAssembly.promising
// for JSPI-suspending imports (sock_send/recv/shutdown). Falls back to
// sync invocation when WebAssembly.promising is unavailable, so behaviour
// is identical for non-suspending wasm programs.
declare const __wasiRunStartAsync: (
  instance: WebAssembly.Instance,
  ctx: { memory: WebAssembly.Memory },
) => Promise<{ exitCode: number; error?: string }>;
export const WASM_RUNNER_VERSION = '0.3.0';

export const WASM_RUNNER_HELP =
  'Usage: wasm-runner [options] <file.wasm> [exportName] [int args...]\n' +
  '       wasm-runner --version\n' +
  '       wasm-runner --wasi-info\n' +
  '\n' +
  'Loads a .wasm module and runs it. Two modes auto-detected from the\n' +
  'module\'s imports:\n' +
  '\n' +
  '  WASI mode  (imports wasi_snapshot_preview1): invokes _start with a\n' +
  '             core WASI WASI shim. stdout/stderr stream to the Process tab.\n' +
  '             exportName argument is optional; defaults to _start.\n' +
  '  Direct mode (no WASI imports): calls the named export with integer\n' +
  '             args and prints the return value.\n' +
  '\n' +
  'Examples:\n' +
  '  wasm-runner ./hello.wasm                 # WASI, runs _start\n' +
  '  wasm-runner ./hello.wasm a b c           # WASI, args [a,b,c]\n' +
  '  wasm-runner ./add.wasm add 3 4           # direct, → 7\n' +
  '  wasm-runner ./fib.wasm fib 10            # direct, → 55\n' +
  '\n' +
  'Limitations (direct mode):\n' +
  '  - Function args are integers only (parseInt). Float / string /\n' +
  '    multi-arg-shapes need a wrapper module.\n' +
  '  - Only integer return values are surfaced.\n' +
  '\n' +
  'Limitations (WASI mode, core WASI):\n' +
  `  - target ABI: ${WASM32_WASI_NIMBUS_ABI.id}.\n` +
  '  - implemented imports: ' + WASI_IMPLEMENTED_FNS.join(', ') + '.\n' +
  '  - filesystem access is rooted at the current Nimbus VFS subtree and\n' +
  '    flushed back after process exit.\n' +
  '  - fd 0 (stdin) returns EOF immediately.\n' +
  '  - pthreads / wasi-threads run CORRECTLY but never in parallel: one core,\n' +
  '    one thread at a time. Build with --target=wasm32-wasip1-threads -pthread\n' +
  '    -Wl,--import-memory,--shared-memory,--max-memory=<bytes> and link\n' +
  '    runtime-contracts/nimbus-threads.c; other threads builds are rejected.\n' +
  '  - Transport: bytes ship via the LOADER modules map, NOT\n' +
  '    WebAssembly.instantiate(bytes) at request time (CSP-blocked).';

export function formatWasmRunnerWasiInfo(): string {
  return JSON.stringify({
    abi: WASM32_WASI_NIMBUS_ABI.id,
    os: WASM32_WASI_NIMBUS_ABI.os,
    target: WASM32_WASI_NIMBUS_ABI.target,
    env: WASM32_WASI_NIMBUS_ABI.env,
    capabilities: WASM32_WASI_NIMBUS_ABI.capabilities,
    imports: WASI_IMPLEMENTED_FNS,
  }, null, 2) + '\n';
}

/**
 * Cheap supervisor-side WASI-detect: scan the wasm import section
 * header bytes for the literal `wasi_snapshot_preview1` module name.
 * No full parser — we just walk the import section and check the
 * module-name string of each entry. False positives are not possible
 * because import-section module names are length-prefixed UTF-8
 * blocks; a substring match against the raw bytes is sufficient
 * (the literal "wasi_snapshot_preview1" doesn't appear inside any
 * other section's well-formed payload at the import position).
 *
 * This avoids `WebAssembly.Module.imports(mod)` which can only run
 * inside a context that holds a precompiled Module — we don't yet
 * have one in the supervisor (CSP blocks request-time compile).
 */
function detectWasiAbi(bytes: Uint8Array): WasiAbi | null {
  // Recognise BOTH 'wasi_snapshot_preview1' (modern) AND 'wasi_unstable'
  // (preview0, what binji-linked binaries import). Which one matters: the two
  // share every function name and every signature but disagree on fd_seek's
  // whence constants and on the filestat layout, so binding the wrong one
  // never traps — it silently returns wrong offsets and wrong file sizes.
  // 'wasi_unstable' is not a substring of 'wasi_snapshot_preview1', so the
  // two needles cannot be confused; a module carrying both is preview1.
  const enc = new TextEncoder();
  const needles: [Uint8Array, WasiAbi][] = [
    [enc.encode('wasi_snapshot_preview1'), 'preview1'],
    [enc.encode('wasi_unstable'), 'preview0'],
  ];
  for (const [needle, abi] of needles) {
    if (bytes.length < needle.length) continue;
    outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (bytes[i + j] !== needle[j]) continue outer;
      }
      return abi;
    }
  }
  return null;
}

/**
 * Build a `run` function suitable for RuntimeSpec.run(). Parameterised
 * over the VFS, env (for env.LOADER), ctx (for the pool's doId-scoped
 * cache key), and the session process supervisor (for `ps` /
 * `logs <pid>` / Process tab integration). Returns a fn that matches
 * the runtime-registry's contract.
 */
export function makeWasmRunner(deps: {
  vfs: SqliteVFS;
  env: any;
  ctx: DurableObjectState;
  processes: SessionProcessSupervisor;
}) {
  return async function runWasm(
    _facetMgr: unknown,
    _code: string,
    opts: RuntimeRunOpts,
  ): Promise<RuntimeRunResult> {
    const vfs = deps.vfs.as(requireVfsCred(opts.cred, 'wasm-runner'));
    // opts.filename is the resolved .wasm path (absolute, /-prefixed
    // by the registry's bypassesScriptRead path).
    // opts.argv is:
    //   WASI mode:   [<extra-args-to-program>...] (or empty)
    //   direct mode: [exportName, intArg1, intArg2, ...]
    const wasmPath = (opts.filename || '').replace(/^\/+/, '');
    const argv = opts.argv || [];

    let bytes: Uint8Array;
    try {
      if (!vfs.exists(wasmPath)) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `wasm-runner: cannot find module '${opts.filename}'\n`,
        };
      }
      bytes = vfs.readFile(wasmPath);
    } catch (e: unknown) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `wasm-runner: cannot read '${opts.filename}': ${e instanceof Error ? e.message : String(e)}\n`,
      };
    }

    // Detect WASI imports BEFORE parsing argv as direct-mode integers.
    // WASI mode treats every argv token as a string passed to the
    // program; direct mode treats argv[0] as export name and the rest
    // as integers.
    const wasiAbi = detectWasiAbi(bytes);
    const isWasi = wasiAbi !== null;

    // Threads are decided here, from the binary, so an unsupported build is
    // rejected before a facet is ever spawned and the diagnosis names the
    // build line rather than a trap deep inside libc.
    const threadsInfo = inspectWasmThreads(bytes);
    const threadsError = wasiThreadsLoadError(threadsInfo);
    if (threadsError) {
      return { exitCode: 1, stdout: '', stderr: `wasm-runner: ${threadsError}\n` };
    }
    const threads = threadsInfo.spawns && threadsInfo.memory
      ? {
          memory: {
            module: threadsInfo.memory.module,
            name: threadsInfo.memory.name,
            initial: threadsInfo.memory.initial,
            maximum: threadsInfo.memory.maximum as number,
          },
        }
      : undefined;

    let exportName: string | undefined;
    let parsedArgs: number[] = [];
    let wasiArgv: string[] = [];

    if (isWasi) {
      // WASI argv convention: argv[0] is the program name. Use the
      // module's filename (without leading slashes) so getopt-style
      // libraries see something sensible.
      const progName = (opts.filename || 'wasm').replace(/^\/+/, '').split('/').pop() || 'wasm';
      wasiArgv = [progName, ...argv];
      // Allow the user to pass `wasm-runner file.wasm _start` as a
      // hint that they really want the _start entry (matches the
      // existing direct-mode invocation shape so probes can be the
      // same). _start is the default for WASI anyway.
      if (argv.length > 0 && argv[0] === '_start') {
        wasiArgv = [progName, ...argv.slice(1)];
      }
    } else {
      exportName = argv[0];
      const intArgs = argv.slice(1);
      if (!exportName) {
        return {
          exitCode: 1,
          stdout: '',
          stderr:
            'wasm-runner: missing export name\n' +
            `Usage: wasm-runner ${opts.filename} <exportName> [int args...]\n`,
        };
      }
      // Parse integer args. Non-integer values are reported as a clear
      // diagnostic rather than silently coerced (Number() would map
      // 'foo' → NaN which the wasm fn would treat as 0 — confusing).
      for (let i = 0; i < intArgs.length; i++) {
        const n = parseInt(intArgs[i], 10);
        if (!Number.isFinite(n)) {
          return {
            exitCode: 1,
            stdout: '',
            stderr:
              `wasm-runner: argument ${i + 1} ('${intArgs[i]}') is not an integer\n`,
          };
        }
        parsedArgs.push(n);
      }
    }

    // Install a declared memory maximum before the bytes leave for the
    // loader. Modules built by wasi-sdk declare a minimum and no maximum, so
    // an unbounded `memory.grow` runs until the facet isolate is killed and
    // the guest never learns it ran out of memory. With a maximum in place
    // the grow instruction returns -1 instead, malloc gets NULL, and the
    // program fails through its own error path with the isolate intact.
    //
    // A module that declares a tighter maximum keeps it, and one whose
    // minimum exceeds the cap is left alone: refusing to run a program we
    // could have run is a worse outcome than the OOM this prevents, and the
    // supervisor cannot report a compile failure as usefully as the guest can
    // report its own allocation failure.
    //
    // A wasi-threads build is untouched: it imports its shared memory and
    // names the ceiling on its own build line (`--max-memory`), so there is no
    // memory section to rewrite and no unbounded growth to prevent.
    let limited = bytes;
    try {
      limited = withMemoryLimit(bytes, DEFAULT_WASM_PROCESS_LIMIT_BYTES);
    } catch (e: unknown) {
      console.warn(
        `wasm-runner: leaving '${opts.filename}' uncapped: ` +
        (e instanceof Error ? e.message : String(e)),
      );
    }

    // Convert Uint8Array (SqliteVFS native) into ArrayBuffer.
    // structuredClone-safe ArrayBuffer is required by the pool's
    // wasmModules contract; sub-views aren't accepted by workerd's
    // modules map either. The slice() call always returns a fresh
    // ArrayBuffer regardless of whether bytes.buffer was originally
    // a Shared variant — TS's overload-resolution narrowing here is
    // overly conservative; cast to ArrayBuffer is correct.
    const buf = limited.buffer.slice(
      limited.byteOffset,
      limited.byteOffset + limited.byteLength,
    ) as ArrayBuffer;

    // The submitted function runs INSIDE the facet isolate. It reads
    // the precompiled WebAssembly.Module the pool injected via
    // globalThis.__NIMBUS_WASM, instantiates it (with WASI imports
    // when needed), and either calls the named export or _start.
    //
    // The fn must be self-contained: serialised via fn.toString,
    // closure references are NOT available inside the facet.
    type WasmCallResult = {
      ok: boolean;
      mode: 'direct' | 'wasi';
      result?: number | string;
      exports?: string[];
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      error?: string;
      fsDiff?: {
        filesWritten: Record<string, string>;
        filesDeleted: string[];
        dirsCreated: string[];
        dirsDeleted: string[];
      };
    };
    const facetFn = async function wasmFacetCall(
      args: {
        mode: 'direct' | 'wasi';
        exportName?: string;
        intArgs?: number[];
        wasiArgv?: string[];
        wasiEnv?: Record<string, string>;
        wasiAbi?: WasiAbi;
        /**
         * The import namespace to bind, resolved supervisor-side.
         *
         * This function is serialized with fn.toString() and evaluated in the
         * facet isolate, where module imports do not exist — reaching for
         * WASI_ABI_NAMESPACE here is a ReferenceError at instantiate time that
         * surfaces as "wasi trap: instantiate failed", with the guest blamed
         * for a defect in the host. Values the facet needs travel as arguments.
         */
        wasiNamespace?: string;
        /**
         * Present only for a wasi-threads build. Carries the imported memory's
         * declared limits, which the host must reproduce exactly — read from
         * the binary supervisor-side because the JS API exposes an import's
         * name but not its type.
         */
        threads?: {
          memory: { module: string; name: string; initial: number; maximum: number };
        };
        wasiFs?: {
          root: string;
          preopens: Array<{ wasiPath: string; vfsPath: string }>;
          files: Record<string, string>;
          dirs: string[];
          modes: Record<string, number>;
          sizes?: Record<string, number>;
          enumeratedRoots?: string[];
          revision?: number;
        };
      },
      facetEnv?: { SUPERVISOR?: unknown },
    ): Promise<WasmCallResult> {
      const wasmTable = (globalThis as any).__NIMBUS_WASM || {};
      const mod = wasmTable['user.wasm'];
      if (!mod) {
        return {
          ok: false,
          mode: args.mode,
          error:
            'globalThis.__NIMBUS_WASM[\'user.wasm\'] not found — the pool ' +
            'did not register the module. Internal error.',
        };
      }

      // ── WASI mode ──
      if (args.mode === 'wasi') {
        const mk = __wasiMakeImports;
        const runStart = __wasiRunStart;
        // WASI socket and polling support P3 / production compatibility fix: bare lexical reference, matching
        // the runStart pattern above. The earlier `(globalThis as any)
        // .__wasiRunStartAsync` lookup returned undefined at runtime
        // because top-level `function` declarations in the preamble's
        // ES-module scope do NOT auto-attach to globalThis. The result
        // was that sock_*/poll_oneoff (wrapped in WebAssembly.Suspending)
        // were invoked from a sync `_start` call stack → V8 trapped with
        // "trying to suspend without WebAssembly.promising". The 11
        // sync-only WASI socket and polling support probes worked because they never hit a
        // Suspending import; the 7 async probes failed because they did.
        // The preamble is statically prepended to this same module body
        // (loader-pool.ts:523-530), so the symbol is guaranteed in
        // scope. typeof guard handles the impossible case of a preamble
        // pre-dating WASI socket and polling support (defensive only).
        const runStartAsync = typeof __wasiRunStartAsync === 'function'
          ? __wasiRunStartAsync
          : null;
        const initFS = __wasiInitFS;
        if (!mk || !runStart || !initFS) {
          return {
            ok: false,
            mode: 'wasi',
            error:
              'WASI preamble missing: __wasi* helpers not defined. ' +
              'Pool preamble may have failed to load.',
          };
        }
        // Install the seed manifest. fd 3 = the user's session root preopen.
        // The shim's fd table is reset by initFS each call.
        if (args.wasiFs) {
          initFS({
            root:            args.wasiFs.root,
            preopens:        args.wasiFs.preopens,
            files:           args.wasiFs.files,
            dirs:            args.wasiFs.dirs,
            modes:           args.wasiFs.modes,
            sizes:           args.wasiFs.sizes,
            enumeratedRoots: args.wasiFs.enumeratedRoots,
            revision:        args.wasiFs.revision,
          });
          // initFS resets the live state, so adoption has to follow it. From
          // here the seed is a cache: content it did not carry is fetched on
          // demand and writes go back as they happen.
          __wasiAdoptSupervisor(facetEnv && facetEnv.SUPERVISOR);
        } else {
          // Minimal FS so __wasiFS isn't null when WASI fns are called.
          initFS({ root: '', preopens: [], files: {}, dirs: [], modes: {} });
        }
        const memRef: { mem: WebAssembly.Memory | null } = { mem: null };
        const abi = args.wasiAbi || 'preview1';
        const wasi = mk({
          argv: args.wasiArgv || [],
          env: args.wasiEnv || {},
          abi,
          threads: !!args.threads,
          // Non-null by ordering, not by check: the table built here is only
          // ever CALLED from inside the guest, and the guest cannot run before
          // `_start` below, by which point memRef.mem is assigned or the call
          // has already returned an error. The shim dereferences the result
          // unguarded, so if that ordering ever stops holding the failure is a
          // TypeError raised inside a suspended syscall — which is why this
          // says so out loud rather than widening the shim's contract.
          getMemory: () => memRef.mem as WebAssembly.Memory,
        });
        // Bind ONLY the namespace this module actually imports, with the
        // import table built for that ABI. Aliasing one preview1 table onto
        // both names — which this did until the encodings were checked
        // against the binaries — gives a preview0 guest inverted fd_seek
        // whence and a 64-byte filestat it decodes as 56, so every lseek
        // lands wrong and every st_size reads back as the nlink field. The
        // signatures are identical, so nothing traps and nothing is logged.
        // The one place the precise table meets WebAssembly's own types, which
        // describe an import object as an untyped index signature. Widening
        // here keeps the precision on the shim's side of the boundary.
        const importObject: Record<string, WebAssembly.ModuleImports> = {
          [args.wasiNamespace || 'wasi_snapshot_preview1']:
            wasi.wasiImport as unknown as WebAssembly.ModuleImports,
        };
        // A threads build imports its memory instead of defining one, because
        // every thread is another instance and they must all address the same
        // bytes. The host creates it — shared, at the module's declared limits
        // — and the scheduler, the syscall layer and each thread instance all
        // read through this one object.
        let sched: WasiThreadScheduler | null = null;
        if (args.threads) {
          let shared: WebAssembly.Memory;
          try {
            shared = new WebAssembly.Memory({
              initial: args.threads.memory.initial,
              maximum: args.threads.memory.maximum,
              shared: true,
            });
          } catch (e: any) {
            // A shared memory reserves its MAXIMUM up front, so an over-large
            // --max-memory fails here rather than when the program grows into
            // it. Say which number did it; the alternative message is a bare
            // RangeError with no link to the build line that chose it.
            return {
              ok: false,
              mode: 'wasi',
              error:
                `wasi-threads: could not reserve the shared memory the module declares `
                + `(${args.threads.memory.initial}–${args.threads.memory.maximum} pages, `
                + `${(args.threads.memory.maximum * 64) / 1024} MiB): ${e?.message || e}. `
                + 'A shared memory reserves its maximum immediately — lower --max-memory.',
            };
          }
          memRef.mem = shared;
          importObject[args.threads.memory.module] = {
            ...(importObject[args.threads.memory.module] || {}),
            [args.threads.memory.name]: shared,
          };
          sched = __wasiThreadsCreate({
            memory: shared,
            startThread: __wasiThreadsStarter(mod as WebAssembly.Module, importObject),
          });
          Object.assign(importObject, sched.hostImports());
        }
        let inst: WebAssembly.Instance;
        try {
          const result: any = await WebAssembly.instantiate(mod as any, importObject);
          inst = (result instanceof WebAssembly.Instance ? result : result.instance);
        } catch (e: any) {
          return {
            ok: false,
            mode: 'wasi',
            error: `instantiate failed: ${e?.message || e}`,
          };
        }
        if (!memRef.mem) memRef.mem = (inst.exports as any).memory as WebAssembly.Memory;
        if (!memRef.mem) {
          return {
            ok: false,
            mode: 'wasi',
            error: 'wasm module did not export a `memory` — WASI requires one.',
          };
        }
        // WASI socket and polling support P3: use async runStart when available so any
        // suspending socket imports can complete via JSPI. The async
        // wrapper falls back to sync invocation internally when
        // WebAssembly.promising isn't available, so this is safe for
        // non-suspending programs too. Legacy preambles (pre-WASI socket and polling support)
        // that ship without __wasiRunStartAsync still work via the
        // sync runStart path.
        const r = sched
          ? await __wasiRunStartThreads(inst, sched)
          : runStartAsync
            ? await runStartAsync(inst, { memory: memRef.mem })
            : runStart(inst, { memory: memRef.mem });
        // Writes reached the session VFS as they happened; this waits for the
        // queue so the caller cannot observe a result before the data lands.
        await __wasiDrainPersist();
        return {
          ok: r.exitCode === 0 && !r.error,
          mode: 'wasi',
          stdout: wasi.getStdout(),
          stderr: wasi.getStderr(),
          exitCode: r.exitCode,
          exports: Object.keys(inst.exports),
          error: r.error,
        };
      }

      // ── Direct mode ──
      let inst: WebAssembly.Instance;
      try {
        // Single-arg instantiate against a precompiled Module — this
        // is the form workerd's CSP DOES allow. The dynamic-bytes
        // form (instantiate(ArrayBuffer)) is what's blocked.
        const result: any = await WebAssembly.instantiate(mod as any, {});
        inst = (result instanceof WebAssembly.Instance ? result : result.instance);
      } catch (e: any) {
        return {
          ok: false,
          mode: 'direct',
          error: `instantiate failed: ${e?.message || e}`,
        };
      }
      const exportNames = Object.keys(inst.exports);
      const fn = (inst.exports as any)[args.exportName!];
      if (typeof fn !== 'function') {
        return {
          ok: false,
          mode: 'direct',
          exports: exportNames,
          error:
            `export '${args.exportName}' is not a function (or not exported). ` +
            `Available exports: ${exportNames.join(', ')}`,
        };
      }
      let out: any;
      try {
        out = fn(...(args.intArgs || []));
      } catch (e: any) {
        return {
          ok: false,
          mode: 'direct',
          exports: exportNames,
          error:
            `${args.exportName}(${(args.intArgs||[]).join(', ')}) threw: ${e?.message || e}`,
        };
      }
      // BigInt (i64) → string; everything else → as-is.
      if (typeof out === 'bigint') return { ok: true, mode: 'direct', result: out.toString(), exports: exportNames };
      return { ok: true, mode: 'direct', result: out, exports: exportNames };
    };

    // PID + log integration. The runtime-registry's contract is
    // runtime-agnostic at the PID layer; node + bun get this for
    // free via runFresh → facetMgr.exec which spawns through the
    // process supervisor. wasm-runner uses NimbusLoaderPool directly
    // (compute-only, no SUPERVISOR binding needed) so we have to
    // allocate the PID + log entries by hand.
    const cmdLabel =
      'wasm-runner ' +
      (opts.filename || '').replace(/^\/+/, '/') +
      ' ' +
      argv.join(' ');
    const procEntry = deps.processes.spawn(
      cmdLabel.trim(),
      ['wasm-runner', ...argv],
      opts.cwd || '/home/user',
    );
    const pid = procEntry.pid;

    // Pass-through env vars (Nimbus shell sets HOME/USER/PATH/etc.). The
    // runtime-registry's RuntimeRunOpts carries env on the way in; we
    // forward to the WASI shim. Direct mode doesn't use env.
    const wasiEnv: Record<string, string> = isWasi
      ? { ...(opts.env || {}), ...WASM32_WASI_NIMBUS_ABI.env }
      : {};

    // ── filesystem WASI: seed a manifest of the user's session VFS ──
    //
    // The user's cwd at invocation time is the session-root preopen anchor.
    // WASI programs see it as fd 3 mapped to '/'. The seed describes the
    // subtree rather than copying it: content is demand-loaded through the
    // supervisor on first read and writes go back as they happen, so a
    // program that never exits still persists.
    //
    // For direct mode there's no FS exposure — wasm runs in pure
    // compute-only mode, no preopens.
    let wasiFs: import('./wasi-instance.js').WasiFsSnapshot | undefined;
    let wasiFsBytes = 0;
    let wasiFsFiles = 0;
    if (isWasi) {
      // Session root = cwd of the shell invocation. Falls back to /home/user.
      const cwd = (opts.cwd || '/home/user').replace(/^\/+/, '');
      const seed = manifestVfs(vfs, cwd, { revision: vfs.revision(cwd) });
      if ('error' in seed) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `wasm-runner: ${seed.error}\n`,
        };
      }
      wasiFs = {
        ...seed.snapshot,
        // fd 3 → '/' mapping (covers the user's session subtree).
        preopens: [{ wasiPath: '/', vfsPath: seed.snapshot.root }],
      };
      wasiFsBytes = seed.bytes;
      wasiFsFiles = seed.files;
    }

    type DispatchOutcome =
      | { ok: true; mode: 'direct'; result?: number | string; exports?: string[] }
      | { ok: true; mode: 'wasi'; stdout?: string; stderr?: string; exitCode?: number; exports?: string[]; error?: string }
      | { ok: false; mode?: 'direct' | 'wasi'; error: string };

    let outcome: DispatchOutcome;
    try {
      // Built here, not earlier: the pool bakes the invoking process's pid
      // into the SUPERVISOR binding's props, and the pid does not exist until
      // the process is spawned above. The supervisor derives the write
      // credential from it, so a pool that binds SUPERVISOR without one has a
      // filesystem that can read but never write.
      const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
      const pool = new NimbusLoaderPool(deps.env, deps.ctx, {
        tag: isWasi ? 'wasm-runner-wasi' : 'wasm-runner',
        concurrency: 1,
        // WASI mode needs the SUPERVISOR binding: it is what backs the
        // filesystem with the live session VFS instead of a spawn-time copy.
        // Direct (compute-only) mode has no filesystem at all, so it keeps the
        // bindings table empty and the facet isolate boots fast.
        omitSupervisor: !isWasi,
        supervisorPid: pid,
        // WASI mode: ship the WASI shim source as a module-init preamble
        // so `__wasiMakeImports` is in scope when the facet fn runs.
        // Direct mode: no preamble (saves a few KB per submit).
        preamble: isWasi ? WASI_INSTANCE_PREAMBLE_SRC : undefined,
      });

      const submitArgs = isWasi
        ? {
            mode: 'wasi' as const,
            wasiArgv,
            wasiEnv,
            wasiAbi: wasiAbi ?? undefined,
            wasiNamespace: WASI_ABI_NAMESPACE[wasiAbi ?? 'preview1'],
            threads,
            wasiFs,
          }
        : { mode: 'direct' as const, exportName: exportName!, intArgs: parsedArgs };
      outcome = (await pool.submit(
        facetFn,
        submitArgs,
        {
          wasmModules: { 'user.wasm': buf },
          // 30s ceiling for compute. Most wasm calls return in
          // microseconds; runaway loops hit this and the pool returns
          // a TimeoutError that surfaces as exitCode 1 + stderr.
          timeoutMs: 30_000,
        },
      )) as DispatchOutcome;
    } catch (e: any) {
      outcome = { ok: false, error: `dispatch failed: ${e?.message || e}` };
    }

    let exitCode: number;
    let stdout: string;
    let stderr: string;

    // The facet's `ok` field encodes "clean exit (code 0, no trap)" — but
    // for WASI mode, a non-zero proc_exit IS legitimate program output,
    // not a wasm-runner error. Branch on `mode` first so we surface the
    // program's exit code unchanged.
    if (outcome.mode === 'wasi') {
      // WASI mode: pass through stdout/stderr the wasm wrote via
      // fd_write. Exit code from proc_exit (or 0 on natural fall-through).
      // If runStart reported an `error` (wasm trapped, _start missing,
      // …), append it to stderr but still surface its exitCode (default
      // 1 from runStart on trap) so callers can distinguish.
      const wasiOut = outcome as Extract<DispatchOutcome, { mode: 'wasi' }> | (DispatchOutcome & { mode: 'wasi' });
      // Either branch carries optional stdout/stderr/exitCode/error.
      stdout = (wasiOut as any).stdout || '';
      stderr = (wasiOut as any).stderr || '';
      if ((wasiOut as any).error) {
        stderr = (stderr ? stderr : '') +
          `wasm-runner: wasi trap: ${(wasiOut as any).error}\n`;
      }
      exitCode = (wasiOut as any).exitCode ?? ((wasiOut as any).ok ? 0 : 1);
    } else if (!outcome.ok) {
      // Direct-mode failure or pre-instantiate dispatch failure — shell
      // sees rc=1 + stderr.
      exitCode = 1;
      stdout = '';
      stderr = `wasm-runner: ${outcome.error}\n`;
    } else {
      // Direct mode success: surface the result on stdout. void-return
      // is success with no output; callers chain `&& echo OK` to detect.
      stdout =
        outcome.result === undefined || outcome.result === null
          ? ''
          : String(outcome.result) + '\n';
      stderr = '';
      exitCode = 0;
    }

    // Mirror stdout/stderr into the per-PID ring so `logs <pid>`
    // and the Process tab WS log stream see the output. The
    // append-then-markExit ordering matches what shellExecuteTracked
    // does in init.ts:1559+ (Fix 5 contract).
    if (stdout) {
      try { deps.processes.appendOutput(pid, 'stdout', stdout); } catch {}
    }
    if (stderr) {
      try { deps.processes.appendOutput(pid, 'stderr', stderr); } catch {}
    }
    try { deps.processes.exit(pid, exitCode); } catch {}
    try {
      if (!deps.processes.getExit(pid)) {
        deps.processes.markExit(pid, exitCode);
      }
    } catch {}

    return { exitCode, stdout, stderr };
  };
}
