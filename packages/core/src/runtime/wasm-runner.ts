/**
 * wasm-runner.ts — native-WASM runner over the facet host.
 *
 * The runner never compiles the user's bytes itself: it hands them to a facet
 * ({@link ./facet-host.js}) as `user.wasm` and reads the compiled
 * `WebAssembly.Module` back off `globalThis.__NIMBUS_WASM['user.wasm']`. On
 * workerd that indirection is not stylistic — direct
 * `WebAssembly.instantiate(bytes)` is refused by CSP at request time in both
 * the supervisor and facet isolates, and the modules map is the one path where
 * the compile happens during module load, which is permitted.
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
 *   3. Facet.submit() with wasmModules: { 'user.wasm': bytes } — the
 *      host compiles the image and publishes it on the facet's
 *      `globalThis.__NIMBUS_WASM`.
 *   4. The submitted fn runs inside the inner facet:
 *      - reads globalThis.__NIMBUS_WASM['user.wasm'] (the precompiled
 *        Module the facet host registered)
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
 *   - No sleeps, caller-side retries, or catch-and-continue around facet
 *     failures. The host owns retry behavior.
 *   - The try/catch around vfs.readFile is a legitimate I/O boundary;
 *     the diagnostic propagates as exitCode 1 + stderr line.
 *   - NO direct WebAssembly.instantiate(bytes) at request time — workerd
 *     CSP rejects that path, and the facet host exists to make it moot.
 */

import type { RuntimeRunOpts, RuntimeRunResult, RuntimeSpec } from './runtime-registry.js';
import { WASM_CALL_TASK } from './compiled-bodies.generated.js';
import type { Facet, FacetHost } from './facet-host.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
import { stdinBytesOf } from '../shell/stdin-adapter.js';
import { gateSyncLaunch, requireVfsCred, WASM32_WASI_NIMBUS_ABI, type NimbusFilesystemAuthority } from './os-contracts.js';
import { withHostView } from './process-files.js';
import { WASI_INSTANCE_PREAMBLE_SRC, WASI_IMPLEMENTED_FNS, WASI_ABI_NAMESPACE } from './wasi-instance.js';
import type { WasmCallResult } from './facet-tasks.js';
import type { WasiAbi } from './wasi-instance.js';
import { inspectWasmThreads, wasiThreadsLoadError } from './wasi-threads.js';
import { withMemoryLimit, DEFAULT_WASM_PROCESS_LIMIT_BYTES } from './wasm-memory.js';
import { wasmInterface } from './wasm-binary.js';
import { errorText } from '../_shared/error-text.js';
import { unsettledNoteOf } from '../_shared/process-fs-client.js';
import type { ResidentFilesystemStats } from './wasi/resident-filesystem.js';
import { exists } from '../vfs/vfs.js';
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
  '  - Transport: bytes ship through the facet host, NOT\n' +
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
 * The WASI ABI a module binds, from the module names in its import section:
 * `wasi_snapshot_preview1` is preview1 and `wasi_unstable` (what
 * binji-linked binaries import) preview0; null for a module that imports
 * neither. Which one matters: the two share every function name and every
 * signature but disagree on fd_seek's whence constants and on the filestat
 * layout, so binding the wrong one never traps — it silently returns wrong
 * offsets and wrong file sizes. A module importing both is preview1. The
 * namespace's text anywhere else in the binary (a custom section, a string
 * in a data segment) decides nothing.
 *
 * Read from the binary because `WebAssembly.Module.imports(mod)` needs a
 * compiled module, which the supervisor does not have (CSP blocks
 * request-time compile).
 */
function detectWasiAbi(bytes: Uint8Array): WasiAbi | null {
  const modules = new Set(wasmInterface(bytes).imports.map((entry) => entry.module));
  if (modules.has(WASI_ABI_NAMESPACE.preview1)) return 'preview1';
  if (modules.has(WASI_ABI_NAMESPACE.preview0)) return 'preview0';
  return null;
}

/**
 * Build a `run` function suitable for RuntimeSpec.run(). Parameterised
 * over the VFS, the facet host the module is compiled and run on, and the
 * session process supervisor (for `ps` / `logs <pid>` / Process tab
 * integration). Returns a fn that matches the runtime-registry's contract.
 */
export function makeWasmRunner(deps: {
  filesystem: NimbusFilesystemAuthority;
  facets: FacetHost;
  processes: SessionProcessSupervisor;
}) {
  return async function runWasm(
    _code: string,
    opts: RuntimeRunOpts,
  ): Promise<RuntimeRunResult> {
    const cred = requireVfsCred(opts.cred, 'wasm-runner');
    // opts.filename is the resolved .wasm path (absolute, /-prefixed
    // by the registry's bypassesScriptRead path).
    // opts.argv is:
    //   WASI mode:   [<extra-args-to-program>...] (or empty)
    //   direct mode: [exportName, intArg1, intArg2, ...]
    const wasmPath = (opts.filename || '').replace(/^\/+/, '');
    const argv = opts.argv || [];
    const notHydrated = await gateSyncLaunch(deps.filesystem, opts.cwd || '/home/user', opts.filename || null, argv);
    if (notHydrated !== null) return { exitCode: 1, stdout: '', stderr: `wasm-runner: ${notHydrated}\n` };

    // The program is read as the invoking credential before a process exists
    // for it, so a host lease carries the read rather than a process binding.
    let bytes: Uint8Array;
    try {
      // A whole program image bypasses the content cache: it is read once and
      // handed to the facet's module map, never re-read from this isolate.
      const program = await withHostView(deps.filesystem, cred, async (fs) =>
        (await fs.exists(wasmPath)) ? fs.readFileUncached(wasmPath) : null);
      if (program === null) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `wasm-runner: cannot find module '${opts.filename}'\n`,
        };
      }
      bytes = program;
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
    // structuredClone-safe ArrayBuffer is required by the facet host's
    // wasmModules contract; sub-views aren't accepted by workerd's
    // modules map either. The slice() call always returns a fresh
    // ArrayBuffer regardless of whether bytes.buffer was originally
    // a Shared variant — TS's overload-resolution narrowing here is
    // overly conservative; cast to ArrayBuffer is correct.
    const buf = limited.buffer.slice(
      limited.byteOffset,
      limited.byteOffset + limited.byteLength,
    ) as ArrayBuffer;


    // PID + log integration. The runtime-registry's contract is
    // runtime-agnostic at the PID layer; node + bun get this for
    // free via runFresh → facetMgr.exec which spawns through the
    // process supervisor. wasm-runner opens a facet directly, so it has to
    // allocate the PID + log entries by hand.
    //
    // A child of the command that ran it, under the credential its view is
    // bound with: a host answers the facet's syscalls under the credential
    // the table holds for this pid (the Durable Object host does, through
    // SupervisorRPC), and the reap of the command's tree takes it. At the top
    // of the table it ran as the session user whoever started it.
    const cmdLabel =
      'wasm-runner ' +
      (opts.filename || '').replace(/^\/+/, '/') +
      ' ' +
      argv.join(' ');
    const brokerPid = opts.stdinPid;
    const owned = brokerPid === undefined;
    const procEntry = owned ? deps.processes.spawn(
      cmdLabel.trim(),
      ['wasm-runner', ...argv],
      opts.cwd || '/home/user',
      { parentPid: opts.invokerPid, cred },
    ) : deps.processes.get(brokerPid);
    if (!procEntry || procEntry.state !== 'running') throw new Error('WASI broker process is not running');
    const pid = procEntry.pid;
    const killed = new AbortController();
    const runSignal = opts.signal ? AbortSignal.any([opts.signal,killed.signal]) : killed.signal;
    deps.processes.setTerminator(pid, () => killed.abort());
    const inputPump = !owned ? null : opts.stdin ? deps.processes.pumpInput(pid, stdinBytesOf(opts.stdin)) : null;
    if (!deps.processes.hasInput(pid)) { deps.processes.openInput(pid); deps.processes.endInput(pid); }
    const releaseOutput = opts.output
      ? deps.processes.subscribeOutputBytes(pid, chunk => opts.output!(chunk.stream, chunk.data)) : null;
    if (releaseOutput) deps.processes.setForeground(pid, true);

    // Pass-through env vars (Nimbus shell sets HOME/USER/PATH/etc.). The
    // runtime-registry's RuntimeRunOpts carries env on the way in; we
    // forward to the WASI shim. Direct mode doesn't use env.
    const wasiEnv: Record<string, string> = isWasi
      ? { ...(opts.env || {}), ...WASM32_WASI_NIMBUS_ABI.env }
      : {};

    // ── filesystem WASI: the user's cwd is the session-root preopen ──
    //
    // WASI programs see it as fd 3 mapped to '/'. Nothing is walked or copied:
    // every file the guest touches is read from and written to the authority
    // through the supervisor, under this process's credential.
    //
    // For direct mode there's no FS exposure — wasm runs in pure
    // compute-only mode, no preopens.
    let wasiFs: import('@nimbus-sh/core/runtime/wasi-instance.js').WasiFsSnapshot | undefined;
    const processFs = isWasi ? deps.filesystem.bind({ pid, cred }) : null;
    if (processFs) {
      // Session root = cwd of the shell invocation. Falls back to /home/user.
      const root = (opts.cwd || '/home/user').replace(/^\/+/, '');
      wasiFs = { root, preopens: [{ wasiPath: '/', vfsPath: root }], cred: { uid: cred.uid, gid: cred.gid, groups: [...cred.groups] } };
    }

    /**
     * What the facet call resolved to, or the supervisor-side dispatch failure
     * that never reached it — and so names no mode.
     */
    type DispatchOutcome = WasmCallResult | { ok: false; mode?: undefined; error: string };

    let outcome: DispatchOutcome;
    let facet: Facet | null = null;
    try {
      // Opened here, not earlier: the host bakes the invoking process's pid
      // into the facet's supervisor capability, and the pid does not exist
      // until the process is spawned above. The supervisor derives the write
      // credential from it, so a facet given the capability without one has a
      // filesystem that can read but never write.
      facet = deps.facets.open({
        tag: isWasi ? 'wasm-runner-wasi' : 'wasm-runner',
        concurrency: 1,
        // WASI mode needs the supervisor capability: it is what backs the
        // filesystem with the live session VFS instead of a spawn-time copy.
        // Direct (compute-only) mode has no filesystem at all, so it asks for
        // no capability and the facet boots fast.
        syscalls: processFs ? { vfs: processFs, pid, processes: deps.processes } : undefined,
        // WASI mode: ship the WASI shim source as a facet preamble so
        // `__wasiMakeImports` is in scope when the facet fn runs. Direct mode:
        // no preamble (saves a few KB per submit).
        preamble: isWasi ? WASI_INSTANCE_PREAMBLE_SRC : undefined,
      });

      const submitArgs = isWasi
        ? {
            processPid: pid,
            liveOutput: true,
            mode: 'wasi' as const,
            wasiArgv,
            wasiEnv,
            wasiAbi: wasiAbi ?? undefined,
            wasiNamespace: WASI_ABI_NAMESPACE[wasiAbi ?? 'preview1'],
            threads,
            wasiFs,
          }
        : { mode: 'direct' as const, exportName: exportName!, intArgs: parsedArgs };
      outcome = (await facet.submit(
        WASM_CALL_TASK,
        submitArgs,
        {
          wasmModules: { 'user.wasm': buf },
          signal: runSignal,
        },
      )) as DispatchOutcome;
    } catch (e) {
      // Killed: the program ends as an interrupted one does, with no error of its own.
      outcome = runSignal.aborted
        ? { ok: false, mode: 'wasi', exitCode: 130, stdout: '', stderr: unsettledNoteOf(e) }
        : { ok: false, error: `dispatch failed: ${errorText(e)}` };
    } finally {
      facet?.dispose();
      inputPump?.stop();
      if (owned) deps.processes.closeInput(pid);
      releaseOutput?.();
      if (releaseOutput) deps.processes.setForeground(pid, false);
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
      stdout = outcome.stdout || '';
      stderr = outcome.stderr || '';
      if (outcome.error) {
        stderr = (stderr ? stderr : '') +
          `wasm-runner: wasi trap: ${outcome.error}\n`;
      }
      exitCode = outcome.exitCode ?? (outcome.ok ? 0 : 1);
      if (opts.env?.NIMBUS_WASI_FS_STATS === '1') stderr += `[wasi-fs] wasm ${JSON.stringify(outcome.fsStats ?? null)}\n`;
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
      await deps.processes.appendOutputBytes(pid, 'stdout', new TextEncoder().encode(stdout));
    }
    if (stderr) {
      await deps.processes.appendOutputBytes(pid, 'stderr', new TextEncoder().encode(stderr));
    }
    try { deps.processes.exit(pid, exitCode); } catch {}
    try {
      if (!deps.processes.getExit(pid)) {
        deps.processes.markExit(pid, exitCode);
      }
    } catch {}

    const streamed = 'streamedOutput' in outcome && outcome.streamedOutput === true;
    return { exitCode, stdout: streamed ? '' : stdout, stderr };
  };
}

/**
 * The `wasm-runner` command, whole.
 *
 * Its name, its version, its help and its `--wasi-info` verb belong to the
 * runner, not to whoever registers it. Two callers restating them — a Durable
 * Object session and an embedded workspace — is two places for the help text
 * to drift from the shim it describes.
 */
export function wasmRunnerSpec(deps: {
  filesystem: NimbusFilesystemAuthority;
  facets: FacetHost;
  processes: SessionProcessSupervisor;
}): RuntimeSpec {
  return {
    name: 'wasm-runner',
    version: WASM_RUNNER_VERSION,
    helpText: WASM_RUNNER_HELP,
    subcommands: {
      '--wasi-info': async (ctx): Promise<number> => {
        ctx.stdout.write(formatWasmRunnerWasiInfo());
        return 0;
      },
    },
    // The registry skips the read-source / shebang-strip / esbuild-transform
    // flow: args[0] is a .wasm path, and this runner reads the bytes itself.
    bypassesScriptRead: true,
    run: makeWasmRunner(deps),
  };
}
