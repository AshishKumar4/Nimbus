/**
 * cpython-runner.ts — `python` / `python3` / `pip`, on CPython 3.13 built for
 * wasm32-wasi.
 *
 * This replaces the Pyodide runner, and the reason is not the interpreter: it
 * is the filesystem. Pyodide is CPython built with Emscripten, so it brings its
 * own MEMFS, and every invocation had to copy the session's files in and diff
 * them back out through vfs-snapshot.ts. That made Python the last runtime with
 * a private, parallel filesystem. This build talks to runtime/wasi/preamble.ts
 * like clang, bash and ruby do — `open()` in Python is the same syscall as
 * `open()` in C — so there is nothing to copy and nothing to diff.
 *
 * What follows from that:
 *   - manifestVfs, not snapshotVfs: the facet is given sizes and modes and
 *     demand-loads the handful of files the program actually opens.
 *   - supervisorPid, not omitSupervisor: a pool without a supervisor can read
 *     the seeded manifest and can never write anything back. It looks like it
 *     works.
 *   - No Python-level socket shim. CPython's _socket is real here, over
 *     nimbus-net.c and the host's synthetic paths, so loopback is ordinary
 *     socket code rather than a monkey-patch.
 *
 * The interpreter is a WASI reactor (see packages/worker/wasm/python), because
 * a command module's _start runs once and that only covers `python script.py`.
 */

import type { FacetManager } from '../facets/manager.js';
import type { NimbusLoaderPool } from '../loaders/loader-pool.js';
import type { CommandContext } from '../substrate/lifo/commands/types.js';
import { resolveVfsPath } from '../vfs/path.js';
import type { CredentialedVfs, SqliteVFS } from '../vfs/sqlite-vfs.js';
import { hasLeadingCliFlag } from './cli-flags.js';
import { CPYTHON_PREAMBLE_TAIL } from './cpython-preamble.js';
import { getFacetManagerLoaderHost } from './facet-loader-host.js';
import { requireVfsCred } from './os-contracts.js';
import {
  buildPipInvocation,
  type PipInvocation,
  PYTHON_SITE_PACKAGES_ROOT,
  type PythonPipRuntimeContext,
} from './python-pip.js';
import type { RuntimeManifest } from './runtime-catalog.js';
import { manifestVfs } from './vfs-manifest.js';
import { VIRTUAL_SOCKET_KERNEL_SRC } from './virtual-socket-kernel.generated.js';
import { WASI_INSTANCE_PREAMBLE_SRC } from './wasi-instance.js';

const PYTHON_VERSION_FLAGS = new Set(['--version', '-V']);
const PYTHON_HELP_FLAGS = new Set(['--help', '-h']);

/** Where `nimbus install python` stages the interpreter inside the session. */
const CPYTHON_WASM_REL = 'share/cpython/python.wasm';
const CPYTHON_STDLIB_REL = 'share/cpython/python313.zip';
/** Where the guest expects to find them; nimbus_py_init is told this prefix. */
const CPYTHON_HOME = '/usr/local';
const CPYTHON_STDLIB_GUEST = 'usr/local/lib/python313.zip';
const CPYTHON_MARKER_GUEST = 'usr/local/lib/python3.13/os.py';

/**
 * The one canonical facet preamble. Composed in exactly one place: a
 * hand-rolled second copy is how ruby-repl once drifted into booting a VM whose
 * language prelude was missing.
 */
export function buildCPythonPreamble(): string {
  return [
    VIRTUAL_SOCKET_KERNEL_SRC,
    WASI_INSTANCE_PREAMBLE_SRC,
    CPYTHON_PREAMBLE_TAIL,
  ].join('\n');
}

interface ParsedPyArgv {
  mode: 'inline' | 'script' | 'stdin';
  inlineCode: string;
  scriptPath: string;
  scriptArgs: string[];
  error?: string;
  exitCode: number;
}

/**
 * Python's CLI, as far as a sandbox needs it. Flags that only affect an
 * interactive tty or bytecode caching are accepted and ignored; anything else
 * is refused by name rather than silently doing something different.
 */
function parsePythonArgv(argv: string[]): ParsedPyArgv {
  const fail = (error: string): ParsedPyArgv =>
    ({ mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [], exitCode: 2, error });
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '-c') {
      const code = argv[i + 1];
      if (code === undefined) return fail('Argument expected for the -c option');
      return { mode: 'inline', inlineCode: code, scriptPath: '', scriptArgs: argv.slice(i + 2), exitCode: 0 };
    }
    if (a === '-m') {
      const mod = argv[i + 1];
      if (mod === undefined) return fail('Argument expected for the -m option');
      const rest = argv.slice(i + 2);
      const inlineCode = [
        'import runpy, sys',
        `sys.argv = ${JSON.stringify([mod, ...rest])}`,
        `runpy.run_module(${JSON.stringify(mod)}, run_name='__main__', alter_sys=True)`,
      ].join('\n');
      return { mode: 'inline', inlineCode, scriptPath: '', scriptArgs: rest, exitCode: 0 };
    }
    if (a === '-') {
      return { mode: 'stdin', inlineCode: '', scriptPath: '-', scriptArgs: argv.slice(i + 1), exitCode: 0 };
    }
    if (!a.startsWith('-')) {
      return { mode: 'script', inlineCode: '', scriptPath: a, scriptArgs: argv.slice(i + 1), exitCode: 0 };
    }
    if (/^-[OBuEItcsx]+$/.test(a)) { i++; continue; }
    return fail(`unknown option: ${a}`);
  }
  // No mode argument. init.ts routes a bare `python` to the REPL before it gets
  // here, so reaching this point means flags without a program.
  return fail("no program given. Use 'python -c \"code\"', 'python -m <module>' or 'python script.py'.");
}

/**
 * Whether this invocation should get a resident process rather than a one-shot.
 * A script or `-m` can bind a port and keep serving; pip never does.
 */
function shouldRunAsResidentProcess(argv: string[], parsed: ParsedPyArgv, pipMode: boolean): boolean {
  if (pipMode) return false;
  if (parsed.mode === 'script') return true;
  if (argv[0] === '-m' && argv[1] && argv[1] !== 'pip') return true;
  return false;
}

/** `python -m pip ...` is pip, reached the long way round. */
async function buildPythonModulePipInvocation(
  argv: string[],
  cwd: string,
  vfs: CredentialedVfs,
  runtimeContext: PythonPipRuntimeContext,
): Promise<PipInvocation> {
  if (argv[0] !== '-m' || argv[1] !== 'pip') return { mode: 'none', code: '', exitCode: 0 };
  return await buildPipInvocation(argv.slice(2), 'pip', cwd, vfs, runtimeContext);
}

function formatPythonCommand(binName: string, argv: string[]): string {
  return [binName, ...argv].map((part) =>
    (/^[A-Za-z0-9_./:=@+-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CPythonFacetResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

/**
 * Facet-side entry. Serialized with fn.toString(), so it captures nothing and
 * names no import: everything it needs is on globalThis, put there by the
 * preamble.
 */
function cpythonRunFacetFn(args: Record<string, unknown>): Promise<CPythonFacetResult> {
  const g = globalThis as unknown as Record<string, (a: unknown) => Promise<CPythonFacetResult>>;
  const run = g.__cpythonRun;
  if (typeof run !== 'function') {
    return Promise.resolve({
      stdout: '', stderr: '', exitCode: 127,
      error: 'cpython preamble missing: __cpythonRun not in scope',
    });
  }
  return run(args);
}

export function makeCPythonRunnerFactory(deps: {
  facetMgr: FacetManager;
  vfs: SqliteVFS;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) =>
    (ctx: CommandContext) => Promise<number> {
  const { facetMgr } = deps;

  return function cpythonRunnerFactory(manifest, installRoot, binName, _binKind) {
    const findFile = (rel: string): string | null => {
      const entry = manifest.files.find((f) => f.path === rel);
      return entry ? `${installRoot}/${entry.path}` : null;
    };
    const wasmVfs = findFile(CPYTHON_WASM_REL);
    const stdlibVfs = findFile(CPYTHON_STDLIB_REL);
    let pool: NimbusLoaderPool | null = null;
    let manifestCache:
      { cred: string; cwd: string; revision: number; result: ReturnType<typeof manifestVfs> } | null = null;

    return async function cpythonBinHandler(ctx: CommandContext): Promise<number> {
      const cred = requireVfsCred(ctx.cred, binName);
      const credKey = `${cred.uid}:${cred.gid}:${cred.groups.join(',')}`;
      const vfs = deps.vfs.as(cred);
      const argv: string[] = ctx.args || [];
      const cwd: string = ctx.cwd || '/home/user';

      const pipRuntimeContext: PythonPipRuntimeContext = {
        // No Pyodide lockfile: there is no curated wheel index behind this
        // interpreter, so pip resolves against PyPI like anywhere else.
        pyodideLockfileText: null,
        runtimeArtifacts: manifest.runtime_artifacts || [],
      };
      const isPipBin = _binKind === 'pip' || binName === 'pip' || binName === 'pip3';
      const pipInvocation = isPipBin
        ? await buildPipInvocation(argv, binName, cwd, vfs, pipRuntimeContext)
        : await buildPythonModulePipInvocation(argv, cwd, vfs, pipRuntimeContext);
      if (pipInvocation.error) {
        ctx.stderr.write(`${binName}: ${pipInvocation.error}\n`);
        return pipInvocation.exitCode;
      }

      if (pipInvocation.mode !== 'pip' && hasLeadingCliFlag(argv, PYTHON_VERSION_FLAGS)) {
        ctx.stdout.write('Python 3.13.14 (CPython, wasm32-wasi, Nimbus runtime)\n');
        return 0;
      }
      if (pipInvocation.mode !== 'pip' && hasLeadingCliFlag(argv, PYTHON_HELP_FLAGS)) {
        ctx.stdout.write(`usage: ${binName} [option] ... [-c cmd | -m mod | file | -] [arg] ...\n`);
        ctx.stdout.write('Nimbus CPython 3.13 runtime (wasm32-wasi).\n');
        ctx.stdout.write('Supported: -c <code>, -m <module>, <file.py>, stdin via -, and the session filesystem directly.\n');
        ctx.stdout.write('zlib, lzma, bz2, hashlib, ssl, sqlite3 and sockets are built in; pure-Python wheels install with pip.\n');
        return 0;
      }

      if (!wasmVfs || !vfs.exists(wasmVfs)) {
        ctx.stderr.write(`${binName}: python.wasm missing (re-run 'nimbus install python')\n`);
        return 127;
      }
      if (!stdlibVfs || !vfs.exists(stdlibVfs)) {
        ctx.stderr.write(`${binName}: python313.zip missing (re-run 'nimbus install python')\n`);
        return 127;
      }

      const parsed: ParsedPyArgv = pipInvocation.mode === 'pip'
        ? { mode: 'inline', inlineCode: pipInvocation.code, scriptPath: '', scriptArgs: [], exitCode: 0 }
        : parsePythonArgv(argv);
      if (parsed.error) {
        ctx.stderr.write(`${binName}: ${parsed.error}\n`);
        return parsed.exitCode;
      }

      let userCode = '';
      let progName = binName;
      let pyArgv: string[] = [binName];
      if (parsed.mode === 'inline') {
        userCode = parsed.inlineCode;
        pyArgv = ['-c', ...parsed.scriptArgs];
      } else if (parsed.mode === 'script') {
        const absPath = resolveVfsPath(parsed.scriptPath, cwd);
        try {
          if (!vfs.exists(absPath)) {
            ctx.stderr.write(`${binName}: can't open file '${parsed.scriptPath}': [Errno 2] No such file or directory\n`);
            return 2;
          }
          userCode = new TextDecoder('utf-8').decode(vfs.readFile(absPath));
        } catch (e: unknown) {
          ctx.stderr.write(`${binName}: ${parsed.scriptPath}: ${errorMessage(e)}\n`);
          return 1;
        }
        progName = parsed.scriptPath;
        pyArgv = [parsed.scriptPath, ...parsed.scriptArgs];
      } else {
        const stdinReader = ctx.stdin;
        userCode = (stdinReader && typeof stdinReader.read === 'function' ? await stdinReader.read() : '') ?? '';
        pyArgv = ['-', ...parsed.scriptArgs];
      }

      // sys.argv is set from Python rather than from WASI argv: the reactor has
      // no argv of its own, and this keeps the one place that decides what the
      // program sees in TypeScript.
      const prelude = [
        'import sys',
        `sys.argv = ${JSON.stringify(pyArgv)}`,
        `sys.path.insert(0, ${JSON.stringify(`/${PYTHON_SITE_PACKAGES_ROOT}`)})`,
        `sys.path.insert(0, ${JSON.stringify(cwd)})`,
      ].join('\n');

      const userEnv: Record<string, string> = { ...(ctx.env || {}) };
      if (!userEnv.HOME) userEnv.HOME = '/home/user';
      if (!userEnv.PYTHONUNBUFFERED) userEnv.PYTHONUNBUFFERED = '1';

      // A manifest, not a copy: sizes and modes only, with the facet demand-
      // loading whatever the program opens. The stdlib zip is covered by it
      // like any other file, which is the whole point of not having a private
      // filesystem any more.
      const stdlibDir = stdlibVfs.replace(/\/[^/]+$/, '');
      const revision = Math.max(
        vfs.revision(cwd),
        vfs.revision(PYTHON_SITE_PACKAGES_ROOT),
        vfs.revision(stdlibVfs),
      );
      let fsManifest = manifestCache && manifestCache.cred === credKey
        && manifestCache.cwd === cwd && manifestCache.revision === revision
        ? manifestCache.result
        : null;
      if (!fsManifest) {
        fsManifest = manifestVfs(vfs, cwd, {
          extraRoots: [PYTHON_SITE_PACKAGES_ROOT, stdlibDir],
          revision,
        });
        manifestCache = { cred: credKey, cwd, revision, result: fsManifest };
      }
      if ('error' in fsManifest) {
        ctx.stderr.write(`${binName}: ${fsManifest.error}\n`);
        return 1;
      }

      // The interpreter looks for its stdlib under CPYTHON_HOME, but the
      // install put it wherever the manifest says. Rather than move bytes, the
      // two paths the guest needs are aliased into the seeded manifest.
      const snapshot = fsManifest.snapshot as unknown as {
        files: Record<string, string>;
        dirs: string[];
        modes: Record<string, number>;
        sizes?: Record<string, number>;
      };
      snapshot.dirs = [...(snapshot.dirs || []), 'usr', 'usr/local', 'usr/local/lib',
        'usr/local/lib/python3.13', 'usr/local/lib/python3.13/lib-dynload'];
      for (const d of snapshot.dirs) snapshot.modes[d] = 7;
      snapshot.modes[CPYTHON_STDLIB_GUEST] = 7;
      snapshot.modes[CPYTHON_MARKER_GUEST] = 7;
      snapshot.files[CPYTHON_MARKER_GUEST] = btoa('# stdlib marker; the modules live in the zip\n');
      snapshot.sizes = snapshot.sizes || {};
      snapshot.sizes[CPYTHON_STDLIB_GUEST] = vfs.stat(stdlibVfs)?.size ?? 0;

      if (!pool) {
        const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
        const host = getFacetManagerLoaderHost(facetMgr);
        pool = new NimbusLoaderPool(host.env, host.ctx, {
          tag: 'cpython-runner',
          concurrency: 1,
          // NOT omitSupervisor. Without it the facet reads the seeded manifest
          // and can never write anything back — the program appears to run and
          // its output never reaches the session.
          supervisorPid: ctx.pid,
          preamble: buildCPythonPreamble(),
          wasmModules: { 'python.wasm': toArrayBuffer(vfs.readFile(wasmVfs)) },
        });
      }

      const facetArgs = {
        userCode: `${prelude}\n${userCode}`,
        pyArgv,
        userEnv,
        progName,
        cwd,
        pythonHome: CPYTHON_HOME,
        supervisorPid: ctx.pid,
        fsSnapshot: snapshot,
      };

      void formatPythonCommand(binName, argv);
      void shouldRunAsResidentProcess(argv, parsed, pipInvocation.mode === 'pip');

      let result: CPythonFacetResult;
      try {
        result = await pool.submit(cpythonRunFacetFn, facetArgs, { timeoutMs: 120_000 });
      } catch (e: unknown) {
        ctx.stderr.write(`${binName}: ${errorMessage(e)}\n`);
        return 1;
      }

      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      if (result.error) {
        ctx.stderr.write(`${binName}: ${result.error}\n`);
        return result.exitCode || 1;
      }
      return result.exitCode;
    };
  };
}
