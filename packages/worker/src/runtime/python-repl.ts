/**
 * python-repl.ts — the interactive `python` prompt.
 *
 * A long-lived facet holds one interpreter and each submitted line is run in
 * it, so definitions, imports and open files survive between prompts. That is
 * the whole reason the interpreter is built as a WASI reactor: a command
 * module's _start runs once.
 *
 * Incompleteness is decided by `codeop.compile_command`, which is what the real
 * Python REPL uses — it returns None for source that is syntactically fine so
 * far but unfinished (an open bracket, a `def` with no body yet), raises
 * SyntaxError for source that can never complete, and otherwise hands back a
 * code object. That distinction is not something to re-derive from error
 * strings; the previous Pyodide implementation asked PyodideConsole for it,
 * which is the same idea reached through a Pyodide-only object.
 *
 * Compiling in 'single' mode also gets the echo right for free: an expression
 * statement goes through sys.displayhook exactly as it does at a real prompt,
 * so `1 + 1` prints `2` and `x = 1` prints nothing, with no wrapper of ours
 * deciding what counts as a result.
 */

import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { FacetManager } from '../facets/manager.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { RuntimeManifest } from '@nimbus-sh/core/runtime/runtime-manifest.js';
import type { ReplAdapter, ReplPushResult } from './repl-session.js';
import { ReplSession } from './repl-session.js';
import { sessionUsesSciVariant } from '@nimbus-sh/core/runtime/python-pip.js';
import { buildCPythonPreamble } from '@nimbus-sh/core/runtime/cpython-runner.js';
import { getFacetManagerLoaderHost } from './facet-loader-host.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';

/** Written by the driver when the source so far cannot yet be run. */
const INCOMPLETE_MARKER = '__NIMBUS_PY_INCOMPLETE__';
/**
 * Written when SystemExit reaches top level.
 *
 * The exit STATUS cannot carry this on its own: `exit()` and `exit(0)` both
 * mean "leave the prompt" and both have status 0, which is exactly what a line
 * that ran fine also returns. Without a marker the REPL treats `exit()` as
 * ordinary output and never leaves.
 */
const EXIT_MARKER = '__NIMBUS_PY_EXIT__';

export interface PythonReplDeps {
  facetMgr: FacetManager;
  vfs: SqliteVFS;
  terminal: WebSocketTerminal;
  /** Per-user-VFS install dir, e.g. 'home/user/.nimbus/runtimes/cpython/3.13.14'. */
  installRoot: string;
  manifest: RuntimeManifest;
  /**
   * The Nimbus shell, when there is one.
   *
   * A multi-line WebSocket frame (`python\nexit(7)`) is split by the shell's
   * input handler, which pushes everything after the first line onto
   * shell.pasteQueue and drains it only when the shell goes idle. The shell is
   * not idle: it is blocked awaiting this REPL. Handing the shell to
   * ReplSession lets it drain that queue on attach, which is the difference
   * between the pasted tail arriving and the prompt hanging.
   */
  shell?: unknown;
  /**
   * The invoking process's pid.
   *
   * The supervisor derives the write credential from it, so a pool that binds
   * SUPERVISOR without one has a filesystem it can read and can never write —
   * every write-back comes back "missing or invalid process pid in props".
   * Absent only for the install-time warm-up, which boots the interpreter and
   * never touches a file.
   */
  pid?: number;
}

interface PythonReplFacetResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

/** Where cpython-runner's catalog spec stages the interpreter. */
const CPYTHON_WASM_REL = 'share/cpython/python.wasm';
const CPYTHON_SCI_WASM_REL = 'share/cpython/python-sci.wasm';
const CPYTHON_SCI_PACKAGES_REL = 'lib/sci-packages.zip';
const CPYTHON_STDLIB_REL = 'lib/python313.zip';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * The per-submission driver, as Python source.
 *
 * Source arrives base64-encoded: a REPL line can contain any quoting, any
 * newline and any unicode, and encoding it is cheaper than being certain about
 * every escape on the way through.
 */
function buildReplDriver(source: string): string {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(source)));
  return [
    'import base64, codeop, sys, traceback',
    'import __main__',
    `__nimbus_src = base64.b64decode("${b64}").decode("utf-8")`,
    '__nimbus_code = False',
    'try:',
    '    __nimbus_code = codeop.compile_command(__nimbus_src, "<stdin>", "single")',
    'except SyntaxError:',
    // A SyntaxError here is source that can never complete, so report it and
    // take the next line rather than leaving the user in a continuation they
    // cannot escape.
    '    traceback.print_exc(limit=0)',
    'except (OverflowError, ValueError):',
    '    traceback.print_exc(limit=0)',
    'if __nimbus_code is None:',
    `    sys.stdout.write("${INCOMPLETE_MARKER}")`,
    'elif __nimbus_code is not False:',
    '    try:',
    '        exec(__nimbus_code, __main__.__dict__)',
    '    except SystemExit as __nimbus_exit:',
    // Caught rather than re-raised: the marker is what distinguishes leaving
    // the prompt from a line that merely succeeded.
    '        __nimbus_code = __nimbus_exit.code',
    '        if __nimbus_code is None:',
    '            __nimbus_code = 0',
    '        elif not isinstance(__nimbus_code, int):',
    '            sys.stderr.write(str(__nimbus_code) + "\\n")',
    '            __nimbus_code = 1',
    `        sys.stdout.write("${EXIT_MARKER}" + str(__nimbus_code) + ":")`,
    '    except BaseException:',
    '        traceback.print_exc()',
  ].join('\n');
}

class PythonReplAdapter implements ReplAdapter {
  private pool: { submit: Function; dispose?: () => void } | null = null;
  /** Which interpreter variant the cached pool holds; see ensurePool. */
  private poolUsesSci = false;
  private deps: PythonReplDeps;
  private wasmBytes: ArrayBuffer | null = null;
  private fsSnapshot: unknown = null;
  private pythonHome = '/usr/local';

  ps1 = '>>> ';
  ps2 = '... ';

  constructor(deps: PythonReplDeps) {
    this.deps = deps;
  }

  banner(): string {
    return (
      'Python 3.13.14 (CPython, wasm32-wasi, Nimbus runtime)\r\n' +
      'Type "exit()" or press Ctrl-D to exit.\r\n'
    );
  }

  async push(source: string): Promise<ReplPushResult> {
    const trimmed = source.trim();
    if (trimmed === 'exit' || trimmed === 'quit') {
      return { kind: 'output', stdout: '', stderr: 'Use exit() or Ctrl-D to exit\n' };
    }
    try {
      await this.ensurePool();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { kind: 'error', stderr: `[python-repl] bootstrap failed: ${message}\n` };
    }

    let result: PythonReplFacetResult;
    try {
      result = await this.submit(buildReplDriver(source));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { kind: 'error', stderr: `[python-repl] dispatch failed: ${message}\n` };
    }

    if (result.stdout.includes(INCOMPLETE_MARKER)) return { kind: 'incomplete' };

    const exitAt = result.stdout.indexOf(EXIT_MARKER);
    if (exitAt >= 0) {
      const rest = result.stdout.slice(exitAt + EXIT_MARKER.length);
      const code = Number.parseInt(rest.slice(0, rest.indexOf(':')), 10);
      return {
        kind: 'exit',
        exitCode: Number.isFinite(code) ? code : 0,
        // Whatever the line printed before exiting is still the user's output.
        stdout: result.stdout.slice(0, exitAt),
        stderr: result.stderr,
      };
    }

    if (result.exitCode !== 0) {
      // A runner-level failure is the only account of why the session is
      // ending; dropping it turns a broken interpreter into a silent return to
      // the shell.
      return {
        kind: 'exit',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr + (result.error ? `[python-repl] ${result.error}\n` : ''),
      };
    }
    return { kind: 'output', stdout: result.stdout, stderr: result.stderr };
  }

  async close(): Promise<void> {
    if (this.pool) {
      try { this.pool.dispose?.(); } catch { /* fail-soft: the session is ending anyway */ }
      this.pool = null;
    }
  }

  private async ensurePool(): Promise<void> {
    const vfsForVariant = this.deps.vfs.as(CRED_KERNEL);
    const sciPath = `${this.deps.installRoot}/${CPYTHON_SCI_WASM_REL}`;
    const wantsSci = sessionUsesSciVariant(vfsForVariant) && vfsForVariant.exists(sciPath);
    // A prompt that was open before `pip install numpy` is holding the
    // interpreter that does not have it. Dropping the pool rebuilds on the next
    // statement, which is the facet restart EXTENSIONS.md says this costs.
    if (this.pool && this.poolUsesSci !== wantsSci) {
      try { this.pool.dispose?.(); } catch { /* fail-soft: it is being replaced */ }
      this.pool = null;
    }
    if (this.pool) return;
    this.poolUsesSci = wantsSci;
    const { installRoot, facetMgr } = this.deps;
    const vfs = vfsForVariant;
    const wasmPath = wantsSci ? sciPath : `${installRoot}/${CPYTHON_WASM_REL}`;
    const stdlibPath = `${installRoot}/${CPYTHON_STDLIB_REL}`;
    if (!vfs.exists(wasmPath)) {
      throw new Error(`python.wasm missing at ${wasmPath} (run 'nimbus install python')`);
    }
    if (!vfs.exists(stdlibPath)) {
      throw new Error(`python313.zip missing at ${stdlibPath} (run 'nimbus install python')`);
    }
    this.wasmBytes = toArrayBuffer(vfs.readFile(wasmPath));

    const { manifestVfs } = await import('@nimbus-sh/core/runtime/vfs-manifest.js');
    // The install root is the Python prefix, so the manifest covers lib/ and
    // etc/ as they are — nothing is aliased into a path the supervisor could
    // not serve.
    const built = manifestVfs(vfs, 'home/user', { extraRoots: [installRoot.replace(/^\/+/, '')] });
    if ('error' in built) throw new Error(built.error);
    // Same workaround as cpython-runner, and it belongs to the same open
    // defect: the guest cannot consume the stdlib as a manifest-only
    // demand-load, though the transport delivers it byte-identically. Seeding
    // it by value is what makes the interpreter start. Remove both together.
    const snapshot = built.snapshot as unknown as { files: Record<string, string> };
    const zipBytes = vfs.readFile(stdlibPath);
    let bin = '';
    const CH = 32768;
    for (let i = 0; i < zipBytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, Array.from(zipBytes.subarray(i, i + CH)));
    }
    snapshot.files[stdlibPath.replace(/^\/+/, '')] = btoa(bin);
    this.fsSnapshot = snapshot;
    this.pythonHome = `/${installRoot.replace(/^\/+/, '')}`;

    const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
    const host = getFacetManagerLoaderHost(facetMgr);
    // A prompt where `open(path, "w")` silently does nothing is worse than one
    // that refuses to start, so the pid decides which pool this is. Written as
    // two literals rather than a spread because the rule that catches this
    // mistake (tests/unit/runtime-pool-supervisor-pid.mjs) reads the options
    // object as text, and a pool whose credential is hidden behind a variable
    // is exactly the shape it exists to find.
    const base = {
      // Distinct from cpython-runner's tag: a REPL facet holds a live
      // interpreter and must never be handed a one-shot invocation.
      tag: wantsSci ? 'python-repl:sci' : 'python-repl',
      concurrency: 1,
      preamble: buildCPythonPreamble(),
      wasmModules: { 'python.wasm': this.wasmBytes },
    };
    const pid = this.deps.pid;
    this.pool = (typeof pid === 'number' && pid > 0
      ? new NimbusLoaderPool(host.env, host.ctx, { ...base, supervisorPid: pid })
      // The install-time warm-up has no invoking process. It boots the
      // interpreter and never touches a file, so it asks for no supervisor
      // rather than binding one it cannot authenticate to.
      : new NimbusLoaderPool(host.env, host.ctx, { ...base, omitSupervisor: true })) as never;
  }

  private async submit(userCode: string): Promise<PythonReplFacetResult> {
    const result = await (this.pool as { submit: Function }).submit(
      pythonReplStepFacetFn,
      {
        userCode,
        pythonHome: this.pythonHome,
        pyArgv: ['python'],
        userEnv: { HOME: '/home/user', PYTHONUNBUFFERED: '1' },
        progName: 'python',
        cwd: '/home/user',
        fsSnapshot: this.fsSnapshot,
      },
      { timeoutMs: 60_000 },
    );
    return result as PythonReplFacetResult;
  }
}

/**
 * Facet-side. Serialized with fn.toString(), so it captures nothing and names
 * no import: __cpythonReplRun is put on globalThis by the preamble, and unlike
 * __cpythonRun it keeps its interpreter between calls.
 */
async function pythonReplStepFacetFn(
  args: Record<string, unknown>,
  facetEnv: { SUPERVISOR?: unknown } | undefined,
): Promise<PythonReplFacetResult> {
  const run = Reflect.get(globalThis, '__cpythonReplRun') as
    ((a: unknown) => Promise<PythonReplFacetResult>) | undefined;
  if (typeof run !== 'function') {
    return {
      stdout: '', stderr: '', exitCode: 127,
      error: 'cpython preamble missing: __cpythonReplRun not in scope',
    };
  }
  const adopt = Reflect.get(globalThis, '__wasiAdoptSupervisor') as
    ((s: unknown) => void) | undefined;
  const drain = Reflect.get(globalThis, '__wasiDrainPersist') as
    (() => Promise<void>) | undefined;
  const supervisor = facetEnv && facetEnv.SUPERVISOR;
  // Published where the boot re-adopts it after the mount, because
  // __wasiInitFS clears the adoption on purpose. Omitting this here — while
  // cpython-runner's entry had it — is what made the prompt start with no
  // filesystem it could read.
  if (supervisor) Reflect.set(globalThis, '__nimbusPySupervisor', supervisor);
  adopt?.(supervisor);
  try {
    return await run(args);
  } finally {
    // A line that wrote a file and then raised still wrote the file.
    await drain?.();
  }
}

export async function runPythonRepl(deps: PythonReplDeps): Promise<number> {
  const adapter = new PythonReplAdapter(deps);
  const session = new ReplSession(adapter, deps.terminal, deps.shell as never);
  return await session.run();
}

/**
 * Pay the interpreter's boot before the user asks for a prompt. Pushing empty
 * source compiles to a no-op, so the only thing it does is bring the facet up.
 */
export async function warmPythonRepl(
  deps: Pick<PythonReplDeps, 'facetMgr' | 'vfs' | 'installRoot' | 'manifest'>,
): Promise<void> {
  const adapter = new PythonReplAdapter(deps as PythonReplDeps);
  await adapter.push('');
  await adapter.close();
}
