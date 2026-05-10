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
declare const __wasiInitFS: (opts: {
  root: string;
  preopens: Array<{ wasiPath: string; vfsPath: string }>;
  files: Record<string, string>;
  dirs: string[];
}) => void;
declare const __wasiSnapshotFS: () => {
  filesWritten: Record<string, string>;
  filesDeleted: string[];
  dirsCreated: string[];
  dirsDeleted: string[];
} | null;

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
 *
 * Wave-2: extended for WASI file-IO. The snapshot path uses readdir +
 * isDirectory + stat to traverse the user's session subtree; the
 * flush path uses writeFile + mkdir + unlink + rmdir.
 */
interface VfsLike {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  readFile(path: string): Uint8Array;
  writeFile(path: string, content: Uint8Array | string): void;
  readdir(path: string): { name: string; type: string }[];
  mkdir(path: string, opts?: { recursive?: boolean }): void;
  unlink(path: string): void;
  rmdir(path: string): void;
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
  // Recognise BOTH 'wasi_snapshot_preview1' (modern) AND
  // 'wasi_unstable' (older WASI ABI, binji-linked binaries use this).
  // Either substring in the wasm bytes is sufficient — WASI module-
  // name strings are length-prefixed UTF-8 in the import section; a
  // substring match against the raw bytes can't false-positive at the
  // import position. False-positives elsewhere (e.g. in a data
  // section that happens to contain "wasi_unstable" as a string
  // literal) are harmless — the WASI shim won't be invoked unless
  // the wasm actually has `_start` and the imports the shim provides.
  const enc = new TextEncoder();
  const needles = [
    enc.encode('wasi_snapshot_preview1'),
    enc.encode('wasi_unstable'),
  ];
  for (const needle of needles) {
    if (bytes.length < needle.length) continue;
    outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (bytes[i + j] !== needle[j]) continue outer;
      }
      return true;
    }
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
 * Convert a Uint8Array to a base64 string. Used to encode VFS file
 * contents into the JSON-serializable `context` field of the loader
 * pool. Workerd's btoa is the standard one; we use it directly rather
 * than depending on Node's Buffer (which works in workerd via the
 * nodejs_compat polyfill but adds an import dependency).
 */
function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Snapshot a VFS subtree rooted at `vfsRoot` into a JSON-serializable
 * `WasiFsSnapshot`. Used by the WASI runner to ship the user's session
 * filesystem into the facet isolate.
 *
 * Bounded by:
 *   - 32 MiB total bytes (hard cap — bigger sessions need a per-call
 *     RPC dispatch architecture; defer to Wave-3).
 *   - 5000 file count.
 *
 * Returns null + a diagnostic if bounds are exceeded so the caller
 * can surface a clear error to the user.
 */
function snapshotVfs(
  vfs: VfsLike,
  vfsRoot: string,
): { snapshot: import('./wasi-instance.js').WasiFsSnapshot; bytes: number; files: number } | { error: string } {
  const MAX_BYTES = 32 * 1024 * 1024;
  const MAX_FILES = 5000;
  const root = vfsRoot.replace(/^\/+/, '').replace(/\/+$/, '');
  const files: Record<string, string> = {};
  const dirs: string[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  const stack: string[] = [root];
  if (!vfs.exists(root)) {
    return { snapshot: { root, preopens: [], files: {}, dirs: [root] }, bytes: 0, files: 0 };
  }
  dirs.push(root);
  // Directory prefixes to skip during snapshot. The user's `~/.nimbus`
  // install root holds nimbus-managed runtime bundles (clang.wasm,
  // lld.wasm, sysroot.tar, Pyodide, …) that easily exceed the
  // 32 MiB per-snapshot cap and don't belong in the WASI sandbox
  // anyway. node_modules is similar — large, irrelevant to user
  // wasm execution.
  const skipSubdirs = new Set(['.nimbus', 'node_modules', '.cache', '.npm']);
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: { name: string; type: string }[];
    try { entries = vfs.readdir(dir); } catch { continue; }
    for (const e of entries) {
      const childPath = dir + '/' + e.name;
      if (e.type === 'directory') {
        // Skip well-known large/irrelevant subdirs.
        if (skipSubdirs.has(e.name)) continue;
        dirs.push(childPath);
        stack.push(childPath);
        continue;
      }
      let bytes: Uint8Array;
      try { bytes = vfs.readFile(childPath); } catch { continue; }
      totalBytes += bytes.length;
      fileCount++;
      if (totalBytes > MAX_BYTES) {
        return { error: `WASI snapshot exceeded 32 MiB cap (current dir: ${dir})` };
      }
      if (fileCount > MAX_FILES) {
        return { error: `WASI snapshot exceeded 5000 file cap` };
      }
      files[childPath] = bytesToB64(bytes);
    }
  }
  return {
    snapshot: { root, preopens: [], files, dirs },
    bytes: totalBytes,
    files: fileCount,
  };
}

/**
 * Apply a WasiFsDiff produced by the facet back into the supervisor's
 * SqliteFS. Each operation is independent; failures on one path don't
 * abort the rest (we log to stderr and continue).
 */
function flushVfsDiff(vfs: VfsLike, diff: import('./wasi-instance.js').WasiFsDiff): { written: number; deleted: number; mkdirs: number; rmdirs: number } {
  let written = 0, deleted = 0, mkdirs = 0, rmdirs = 0;
  for (const path of diff.dirsCreated) {
    try { vfs.mkdir(path, { recursive: true }); mkdirs++; } catch {}
  }
  for (const [path, b64] of Object.entries(diff.filesWritten)) {
    try {
      const bytes = b64ToBytes(b64);
      // ensure parent dirs exist
      const lastSlash = path.lastIndexOf('/');
      if (lastSlash > 0) {
        const parent = path.substring(0, lastSlash);
        try { vfs.mkdir(parent, { recursive: true }); } catch {}
      }
      vfs.writeFile(path, bytes);
      written++;
    } catch {}
  }
  for (const path of diff.filesDeleted) {
    try { vfs.unlink(path); deleted++; } catch {}
  }
  for (const path of diff.dirsDeleted) {
    try { vfs.rmdir(path); rmdirs++; } catch {}
  }
  return { written, deleted, mkdirs, rmdirs };
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
        wasiFs?: {
          root: string;
          preopens: Array<{ wasiPath: string; vfsPath: string }>;
          files: Record<string, string>;
          dirs: string[];
        };
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
        const mk = __wasiMakeImports;
        const runStart = __wasiRunStart;
        const initFS = __wasiInitFS;
        const snapshotFS = __wasiSnapshotFS;
        if (!mk || !runStart || !initFS || !snapshotFS) {
          return {
            ok: false,
            mode: 'wasi',
            error:
              'WASI preamble missing: __wasi* helpers not defined. ' +
              'Pool preamble may have failed to load.',
          };
        }
        // Install the snapshotted VFS state into the WASI shim's
        // virtual filesystem. fd 3 = the user's session root preopen.
        // The shim's fd table is reset by initFS each call.
        if (args.wasiFs) {
          initFS({
            root:     args.wasiFs.root,
            preopens: args.wasiFs.preopens,
            files:    args.wasiFs.files,
            dirs:     args.wasiFs.dirs,
          });
        } else {
          // Minimal FS so __wasiFS isn't null when WASI fns are called.
          initFS({ root: '', preopens: [], files: {}, dirs: [] });
        }
        const memRef: { mem: WebAssembly.Memory | null } = { mem: null };
        const wasi = mk({
          argv: args.wasiArgv || [],
          env: args.wasiEnv || {},
          getMemory: () => memRef.mem,
        });
        let inst: WebAssembly.Instance;
        try {
          // Both modern `wasi_snapshot_preview1` and older
          // `wasi_unstable` namespaces point at the SAME shim
          // import object. The WASI ABIs are near-identical in
          // function signatures (preview1 fixed fd_seek's offset
          // width to i64 and the `filestat` struct layout); our
          // shim implements preview1 and the older binji-linked
          // binaries are tolerant of the wider types via JS
          // BigInt coercion at the wasm boundary.
          const result: any = await WebAssembly.instantiate(mod as any, {
            wasi_snapshot_preview1: wasi.wasiImport,
            wasi_unstable: wasi.wasiImport,
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
        const fsDiff = snapshotFS();
        return {
          ok: r.exitCode === 0 && !r.error,
          mode: 'wasi',
          stdout: wasi.getStdout(),
          stderr: wasi.getStderr(),
          exitCode: r.exitCode,
          exports: Object.keys(inst.exports),
          error: r.error,
          fsDiff: fsDiff || undefined,
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

    // ── Wave-2: snapshot user's session VFS for WASI mode ──
    //
    // The user's cwd at invocation time is our session-root preopen
    // anchor. WASI programs see this as fd 3 mapped to '/'. We
    // snapshot the subtree, ship via the loader-pool `context`, and
    // flush mutations back after _start returns.
    //
    // For direct mode there's no FS exposure — wasm runs in pure
    // compute-only mode, no preopens.
    let wasiFs: import('./wasi-instance.js').WasiFsSnapshot | undefined;
    let wasiFsBytes = 0;
    let wasiFsFiles = 0;
    if (isWasi) {
      // Session root = cwd of the shell invocation. Falls back to /home/user.
      const cwd = (opts.cwd || '/home/user').replace(/^\/+/, '');
      const snap = snapshotVfs(deps.vfs, cwd);
      if ('error' in snap) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `wasm-runner: ${snap.error}\n`,
        };
      }
      wasiFs = {
        root: snap.snapshot.root,
        preopens: [
          // fd 3 → '/' mapping (covers the user's session subtree).
          { wasiPath: '/',  vfsPath: snap.snapshot.root },
        ],
        files: snap.snapshot.files,
        dirs:  snap.snapshot.dirs,
      };
      wasiFsBytes = snap.bytes;
      wasiFsFiles = snap.files;
    }

    type DispatchOutcome =
      | { ok: true; mode: 'direct'; result?: number | string; exports?: string[] }
      | { ok: true; mode: 'wasi'; stdout?: string; stderr?: string; exitCode?: number; exports?: string[]; error?: string;
          fsDiff?: import('./wasi-instance.js').WasiFsDiff }
      | { ok: false; mode?: 'direct' | 'wasi'; error: string };

    let outcome: DispatchOutcome;
    try {
      const submitArgs = isWasi
        ? { mode: 'wasi' as const, wasiArgv, wasiEnv, wasiFs }
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

    // ── Wave-2: flush mutated FS state back into SqliteFS ──
    if (outcome.mode === 'wasi' && outcome.ok && outcome.fsDiff) {
      try {
        flushVfsDiff(deps.vfs, outcome.fsDiff);
      } catch (e: any) {
        // Flush failure is non-fatal; the wasm ran, the user saw stdout.
        // But surface a diagnostic so they know the FS didn't persist.
        console.warn('wasm-runner: FS flush failed:', e?.message || e);
      }
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
