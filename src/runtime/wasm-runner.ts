/**
 * wasm-runner.ts — native-WASM runner via the LOADER-modules transport.
 *
 * Re-introduced after the multi-runtime wave's revert. The previous
 * version relied on direct `WebAssembly.instantiate(bytes)` at request
 * time — workerd's CSP blocks that path inside both the supervisor
 * and facet isolates (verified in the multi-runtime feasibility
 * memo). The new version routes through the LOADER's modules map:
 * bytes ride INSIDE the worker code blob, workerd compiles them
 * during the inner worker's MODULE-LOAD phase (the one phase where
 * wasm code generation IS allowed), and the resulting
 * WebAssembly.Module is exposed to the user fn via the
 * NimbusLoaderPool's `globalThis.__NIMBUS_WASM[<name>]` table.
 *
 * The validation that this works on the deployed Cloudflare fleet
 * lives at /workspace/.seal-internal/2026-05-10-wasm-csp/findings.md
 * (`add(3,4) === 7` returned in 11ms warm, 113ms cold).
 *
 * Shell command shape
 * ───────────────────
 *
 *   wasm-runner --version
 *   wasm-runner <file.wasm> <exportName> [int args...]
 *
 * Each invocation:
 *   1. Reads bytes from VFS (or any caller-supplied source).
 *   2. Allocates a PID via processTable (Process tab integration).
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
 * Anti-requirements
 * ─────────────────
 *   - NO setTimeout / NO retry / NO defensive-catch in the dispatch
 *     path. The pool's resilience options handle retries.
 *   - The try/catch around vfs.readFile is a legitimate I/O boundary;
 *     the diagnostic propagates as exitCode 1 + stderr line.
 *   - NO direct WebAssembly.instantiate(bytes) at request time —
 *     that's the architectural mistake from the prior wave.
 */

import type { RuntimeRunOpts, RuntimeRunResult } from './runtime-registry.js';
import { WASI_INSTANCE_PREAMBLE_SRC, WASI_WAVE1_FNS } from './wasi-instance.js';

// ── facet-side globals injected by the WASI preamble ─────────────────
// The preamble (WASI_INSTANCE_PREAMBLE_SRC) runs at facet module-init
// time and declares these top-level. The facet fn below references
// them; tsc needs to know they exist. Empty bodies — only types.
declare const __wasiMakeImports: (opts: {
  argv?: string[];
  env?: Record<string, string>;
  getMemory: () => WebAssembly.Memory | null;
  stdoutWrite?: (s: string) => void;
  stderrWrite?: (s: string) => void;
}) => {
  wasiImport: WebAssembly.ModuleImports;
  getStdout: () => string;
  getStderr: () => string;
};
declare const __wasiRunStart: (
  instance: WebAssembly.Instance,
  ctx: { memory: WebAssembly.Memory },
) => { exitCode: number; error?: string };

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
  '             Wave-1 WASI shim. stdout/stderr stream to the Process tab.\n' +
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
  'Limitations (WASI mode, Wave-1):\n' +
  '  - 16 fns implemented: ' + WASI_WAVE1_FNS.join(', ') + '.\n' +
  '  - path_*, fd_readdir, fd_filestat_*, fd_pread, fd_pwrite, poll_oneoff,\n' +
  '    sock_* return ENOSYS (Wave-2 will add SqliteFS-backed paths).\n' +
  '  - fd 0 (stdin) returns EOF immediately.\n' +
  '  - Transport: bytes ship via the LOADER modules map, NOT\n' +
  '    WebAssembly.instantiate(bytes) at request time (CSP-blocked).';

/**
 * Minimal VFS shape we depend on. Avoids importing the full
 * SqliteVFS type tree from the supervisor module graph — this file
 * is part of `src/runtime/`, importing supervisor-specific types
 * would create a cycle.
 */
interface VfsLike {
  exists(path: string): boolean;
  readFile(path: string): Uint8Array;
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
function hasWasiImports(bytes: Uint8Array): boolean {
  const needle = new TextEncoder().encode('wasi_snapshot_preview1');
  if (bytes.length < needle.length) return false;
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Minimal processTable shape — the parts wasm-runner needs to
 * register a PID + mark exit so `ps` and `logs <pid>` see the
 * invocation. Mirrors the surface the .bin handler uses; kept
 * narrow to avoid the cycle through facets/manager.ts.
 */
interface ProcessTableLike {
  spawn(command: string, argv: string[], cwd: string): { pid: number };
  exit(pid: number, code: number): void;
}

interface ProcessLogStoreLike {
  append(pid: number, stream: 'stdout' | 'stderr', data: string): void;
  getExit(pid: number): unknown;
  markExit(pid: number, code: number): void;
}

/**
 * Build a `run` function suitable for RuntimeSpec.run(). Parameterised
 * over the VFS, env (for env.LOADER), ctx (for the pool's doId-scoped
 * cache key), and processTable + processLogs (for `ps` / `logs <pid>` /
 * Process tab integration). Returns a fn that matches the runtime-
 * registry's contract.
 */
export function makeWasmRunner(deps: {
  vfs: VfsLike;
  env: any;
  ctx: DurableObjectState;
  processTable: ProcessTableLike;
  processLogs: ProcessLogStoreLike;
}) {
  return async function runWasm(
    _facetMgr: unknown,
    _code: string,
    opts: RuntimeRunOpts,
  ): Promise<RuntimeRunResult> {
    // opts.filename is the resolved .wasm path (absolute, /-prefixed
    // by the registry's bypassesScriptRead path).
    // opts.argv is:
    //   WASI mode:   [<extra-args-to-program>...] (or empty)
    //   direct mode: [exportName, intArg1, intArg2, ...]
    const wasmPath = (opts.filename || '').replace(/^\/+/, '');
    const argv = opts.argv || [];

    if (!deps.vfs.exists(wasmPath)) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `wasm-runner: cannot find module '${opts.filename}'\n`,
      };
    }

    let bytes: Uint8Array;
    try {
      bytes = deps.vfs.readFile(wasmPath);
    } catch (e: any) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `wasm-runner: cannot read '${opts.filename}': ${e?.message || e}\n`,
      };
    }

    // Detect WASI imports BEFORE parsing argv as direct-mode integers.
    // WASI mode treats every argv token as a string passed to the
    // program; direct mode treats argv[0] as export name and the rest
    // as integers.
    const isWasi = hasWasiImports(bytes);

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

    // Convert Uint8Array (SqliteVFS native) into ArrayBuffer.
    // structuredClone-safe ArrayBuffer is required by the pool's
    // wasmModules contract; sub-views aren't accepted by workerd's
    // modules map either. The slice() call always returns a fresh
    // ArrayBuffer regardless of whether bytes.buffer was originally
    // a Shared variant — TS's overload-resolution narrowing here is
    // overly conservative; cast to ArrayBuffer is correct.
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    // Load the pool lazily — its constructor reaches into env.LOADER
    // which we may not have at every wasm-runner construction site
    // (e.g. unit tests that mock the registry). Lazy import keeps
    // module load cheap.
    const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
    const pool = new NimbusLoaderPool(deps.env, deps.ctx, {
      tag: isWasi ? 'wasm-runner-wasi' : 'wasm-runner',
      concurrency: 1,
      // No SUPERVISOR binding required for compute-only workloads,
      // and omitting it keeps the bindings table minimal so the
      // facet isolate boots fast.
      omitSupervisor: true,
      // WASI mode: ship the WASI shim source as a module-init preamble
      // so `__wasiMakeImports` is in scope when the facet fn runs.
      // Direct mode: no preamble (saves a few KB per submit).
      preamble: isWasi ? WASI_INSTANCE_PREAMBLE_SRC : undefined,
    });

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
    };
    const facetFn = async function wasmFacetCall(
      args: {
        mode: 'direct' | 'wasi';
        exportName?: string;
        intArgs?: number[];
        wasiArgv?: string[];
        wasiEnv?: Record<string, string>;
      },
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
        // __wasiMakeImports / __wasiRunStart are provided by the
        // preamble (see src/runtime/wasi-instance.ts).
        // __wasiMakeImports / __wasiRunStart are top-level const
        // declarations in the preamble — they're in lexical scope
        // when this serialised fn body runs at facet request time.
        // The `declare`'d global types (next file: wasi-instance.ts)
        // satisfy TS so we can reference them directly.
        const mk = __wasiMakeImports;
        const runStart = __wasiRunStart;
        if (!mk || !runStart) {
          return {
            ok: false,
            mode: 'wasi',
            error:
              'WASI preamble missing: __wasiMakeImports / __wasiRunStart not ' +
              'defined. Pool preamble may have failed to load.',
          };
        }
        // memRef: late-binding holder — populated AFTER instantiate
        // since the wasm module exports its own memory. The getMemory
        // closure reads memRef.mem on every call so the WASI shim
        // always sees the live Memory.
        const memRef: { mem: WebAssembly.Memory | null } = { mem: null };
        const wasi = mk({
          argv: args.wasiArgv || [],
          env: args.wasiEnv || {},
          getMemory: () => memRef.mem,
        });
        let inst: WebAssembly.Instance;
        try {
          const result: any = await WebAssembly.instantiate(mod as any, {
            wasi_snapshot_preview1: wasi.wasiImport,
          });
          inst = (result instanceof WebAssembly.Instance ? result : result.instance);
        } catch (e: any) {
          return {
            ok: false,
            mode: 'wasi',
            error: `instantiate failed: ${e?.message || e}`,
          };
        }
        memRef.mem = (inst.exports as any).memory as WebAssembly.Memory;
        if (!memRef.mem) {
          return {
            ok: false,
            mode: 'wasi',
            error: 'wasm module did not export a `memory` — WASI requires one.',
          };
        }
        const r = runStart(inst, { memory: memRef.mem });
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
    // free via runFresh → facetMgr.exec which calls
    // processTable.spawn. wasm-runner uses NimbusLoaderPool directly
    // (compute-only, no SUPERVISOR binding needed) so we have to
    // allocate the PID + log entries by hand.
    const cmdLabel =
      'wasm-runner ' +
      (opts.filename || '').replace(/^\/+/, '/') +
      ' ' +
      argv.join(' ');
    const procEntry = deps.processTable.spawn(
      cmdLabel.trim(),
      ['wasm-runner', ...argv],
      opts.cwd || '/home/user',
    );
    const pid = procEntry.pid;

    // Pass-through env vars (Nimbus shell sets HOME/USER/PATH/etc.). The
    // runtime-registry's RuntimeRunOpts carries env on the way in; we
    // forward to the WASI shim. Direct mode doesn't use env.
    const wasiEnv: Record<string, string> = isWasi ? (opts.env || {}) : {};

    type DispatchOutcome =
      | { ok: true; mode: 'direct'; result?: number | string; exports?: string[] }
      | { ok: true; mode: 'wasi'; stdout?: string; stderr?: string; exitCode?: number; exports?: string[]; error?: string }
      | { ok: false; mode?: 'direct' | 'wasi'; error: string };

    let outcome: DispatchOutcome;
    try {
      const submitArgs = isWasi
        ? { mode: 'wasi' as const, wasiArgv, wasiEnv }
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

    if (!outcome.ok) {
      exitCode = 1;
      stdout = '';
      stderr = `wasm-runner: ${outcome.error}\n`;
    } else if (outcome.mode === 'wasi') {
      // WASI mode: pass through stdout/stderr the wasm wrote via
      // fd_write. Exit code from proc_exit (or 0 on natural fall-through).
      stdout = outcome.stdout || '';
      stderr = outcome.stderr || '';
      if (outcome.error) {
        stderr = (stderr ? stderr : '') +
          `wasm-runner: wasi trap: ${outcome.error}\n`;
      }
      exitCode = outcome.exitCode ?? 0;
    } else {
      // Direct mode: surface the result on stdout. void-return is
      // success with no output; callers chain `&& echo OK` to detect.
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
      try { deps.processLogs.append(pid, 'stdout', stdout); } catch {}
    }
    if (stderr) {
      try { deps.processLogs.append(pid, 'stderr', stderr); } catch {}
    }
    try { deps.processTable.exit(pid, exitCode); } catch {}
    try {
      if (!deps.processLogs.getExit(pid)) {
        deps.processLogs.markExit(pid, exitCode);
      }
    } catch {}

    return { exitCode, stdout, stderr };
  };
}
