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

export const WASM_RUNNER_VERSION = '0.2.0';

export const WASM_RUNNER_HELP =
  'Usage: wasm-runner [options] <file.wasm> <exportName> [int args...]\n' +
  '       wasm-runner --version\n' +
  '\n' +
  'Loads a .wasm module, calls the named export with integer args,\n' +
  'prints the return value.\n' +
  '\n' +
  'Examples:\n' +
  '  wasm-runner ./hello.wasm add 3 4         # → 7\n' +
  '  wasm-runner ./fib.wasm fib 10            # → 55\n' +
  '\n' +
  'Limitations:\n' +
  '  - Function args are integers only (parseInt). Float / string /\n' +
  '    multi-arg-shapes need a wrapper module.\n' +
  '  - Only integer return values are surfaced. memory exports are\n' +
  '    available to the export but not printed.\n' +
  '  - WASI imports are NOT provided. Modules expecting wasi_snapshot\n' +
  '    won\'t instantiate.\n' +
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
 * Build a `run` function suitable for RuntimeSpec.run(). Parameterised
 * over the VFS, env (for env.LOADER), and ctx (for the pool's
 * doId-scoped cache key). Returns a fn that matches the runtime-
 * registry's contract.
 */
export function makeWasmRunner(deps: {
  vfs: VfsLike;
  env: any;
  ctx: DurableObjectState;
}) {
  return async function runWasm(
    _facetMgr: unknown,
    _code: string,
    opts: RuntimeRunOpts,
  ): Promise<RuntimeRunResult> {
    // opts.filename is the resolved .wasm path (absolute, /-prefixed
    // by the registry's bypassesScriptRead path).
    // opts.argv is [exportName, intArg1, intArg2, ...].
    const wasmPath = (opts.filename || '').replace(/^\/+/, '');
    const argv = opts.argv || [];
    const exportName = argv[0];
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

    // Parse integer args. Non-integer values are reported as a clear
    // diagnostic rather than silently coerced (Number() would map
    // 'foo' → NaN which the wasm fn would treat as 0 — confusing).
    const parsedArgs: number[] = [];
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
      tag: 'wasm-runner',
      concurrency: 1,
      // No SUPERVISOR binding required for compute-only workloads,
      // and omitting it keeps the bindings table minimal so the
      // facet isolate boots fast.
      omitSupervisor: true,
    });

    // The submitted function runs INSIDE the facet isolate. It reads
    // the precompiled WebAssembly.Module the pool injected via
    // globalThis.__NIMBUS_WASM, calls
    // WebAssembly.instantiate(module, {}) (allowed: arg is a
    // precompiled Module, not bytes), looks up the export, calls it.
    //
    // The fn must be self-contained: serialised via fn.toString,
    // closure references are NOT available inside the facet.
    type WasmCallResult = {
      ok: boolean;
      result?: number | string;
      exports?: string[];
      error?: string;
    };
    const facetFn = async function wasmFacetCall(
      args: { exportName: string; intArgs: number[] },
    ): Promise<WasmCallResult> {
      const wasmTable = (globalThis as any).__NIMBUS_WASM || {};
      const mod = wasmTable['user.wasm'];
      if (!mod) {
        return {
          ok: false,
          error:
            'globalThis.__NIMBUS_WASM[\'user.wasm\'] not found — the pool ' +
            'did not register the module. Internal error.',
        };
      }
      let inst: WebAssembly.Instance;
      try {
        // Single-arg instantiate against a precompiled Module — this
        // is the form workerd's CSP DOES allow. The dynamic-bytes
        // form (instantiate(ArrayBuffer)) is what's blocked.
        const result: any = await WebAssembly.instantiate(mod as any, {});
        // The single-arg form returns Instance directly (NOT
        // WebAssemblyInstantiatedSource); guard both shapes for
        // forward compat.
        inst = (result instanceof WebAssembly.Instance ? result : result.instance);
      } catch (e: any) {
        return {
          ok: false,
          error: `instantiate failed: ${e?.message || e}`,
        };
      }
      const exportNames = Object.keys(inst.exports);
      const fn = (inst.exports as any)[args.exportName];
      if (typeof fn !== 'function') {
        return {
          ok: false,
          exports: exportNames,
          error:
            `export '${args.exportName}' is not a function (or not exported). ` +
            `Available exports: ${exportNames.join(', ')}`,
        };
      }
      let out: any;
      try {
        out = fn(...args.intArgs);
      } catch (e: any) {
        return {
          ok: false,
          exports: exportNames,
          error:
            `${args.exportName}(${args.intArgs.join(', ')}) threw: ${e?.message || e}`,
        };
      }
      // BigInt (i64) → string; everything else → as-is.
      if (typeof out === 'bigint') return { ok: true, result: out.toString(), exports: exportNames };
      return { ok: true, result: out, exports: exportNames };
    };

    let outcome: WasmCallResult;
    try {
      outcome = await pool.submit(
        facetFn,
        { exportName, intArgs: parsedArgs },
        {
          wasmModules: { 'user.wasm': buf },
          // 30s ceiling for compute. Most wasm calls return in
          // microseconds; runaway loops hit this and the pool returns
          // a TimeoutError that surfaces as exitCode 1 + stderr.
          timeoutMs: 30_000,
        },
      );
    } catch (e: any) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `wasm-runner: dispatch failed: ${e?.message || e}\n`,
      };
    }

    if (!outcome.ok) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `wasm-runner: ${outcome.error}\n`,
      };
    }

    // Surface the result on stdout. void-return is treated as success
    // with no output; callers can chain `&& echo OK` to detect.
    const out =
      outcome.result === undefined || outcome.result === null
        ? ''
        : String(outcome.result) + '\n';
    return { exitCode: 0, stdout: out, stderr: '' };
  };
}
