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
 *
 * FOUR THINGS THIS RUNTIME REDISCOVERED THE HARD WAY, ALL OF WHICH ruby-runner
 * ALREADY KNEW. Read the list rather than finding a fifth:
 *   1. Every entry into the VM goes through WebAssembly.promising, not only the
 *      calls known to park — a Suspending import traps on an unpromised stack
 *      even when it returns a plain integer.
 *   2. The supervisor is adopted AFTER __wasiInitFS, which clears it on purpose,
 *      and the facet drains queued writes in a `finally`.
 *   3. modes are seeded `{ '': 7, tmp: 7, home: 7 }` ahead of the manifest,
 *      because manifestVfs's walk skips the empty root — without it the preopen
 *      at '/' is mode 0 and every traversal under it is EACCES.
 *   4. The loader pool is built per invocation, never cached: supervisorPid is
 *      baked into the SUPERVISOR binding at construction, so a held pool hands
 *      every later caller the first caller's write credential.
 *
 * One ordering in cpythonRunFacetFn is load-bearing and looks redundant: the
 * supervisor stub is PUBLISHED on globalThis and only then adopted, because
 * __wasiInitFS clears the adoption on purpose and the boot re-adopts it from
 * there afterwards. Adopting once at the entry and deleting the Reflect.set
 * leaves a guest that reads the seeded filesystem and silently writes nowhere —
 * every write queued, none landed, no error anywhere. Ruby carries the same
 * pair for the same reason. The drain in the `finally` is the other half: a
 * program that wrote a file and then raised still wrote the file.
 */

import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import { resolveVfsPath } from '../vfs/path.js';
import type { CredentialedVfs, SqliteVFS } from '../vfs/sqlite-vfs.js';
import { z } from 'zod/v4';
import { hasLeadingCliFlag } from './cli-flags.js';
import { CPYTHON_PREAMBLE_TAIL } from './cpython-preamble.js';
import { PYTHON_SERVER_ADAPTER } from './python-server-adapter.js';
import type { FacetHost } from './facet-host.js';
import { requireVfsCred } from './os-contracts.js';
import {
  buildPipInvocation,
  type PipInvocation,
  PYTHON_SITE_PACKAGES_ROOT,
  type PythonPipRuntimeContext,
  sessionUsesSciVariant,
} from './python-pip.js';
import type { RuntimeManifest } from './runtime-manifest.js';
import { VIRTUAL_SOCKET_KERNEL_SRC } from './virtual-socket-kernel.generated.js';
import { WASI_INSTANCE_PREAMBLE_SRC } from './wasi-instance.js';

const PYTHON_VERSION_FLAGS = new Set(['--version', '-V']);
const PYTHON_HELP_FLAGS = new Set(['--help', '-h']);

/** Where `nimbus install python` stages the interpreter inside the session. */
const CPYTHON_WASM_REL = 'share/cpython/python.wasm';
/**
 * The same interpreter with numpy and markupsafe's C speedups linked in, and
 * their Python half. wasm32-wasi has no dlopen, so a compiled package is either
 * in the binary or unavailable; EXTENSIONS.md has why that beat a runtime
 * linker. Chosen per invocation from what the session has installed, so a
 * session that installed none of it pays none of the 7.8 MiB.
 */
const CPYTHON_SCI_WASM_REL = 'share/cpython/python-sci.wasm';
const CPYTHON_SCI_PACKAGES_REL = 'lib/sci-packages.zip';
const CPYTHON_STDLIB_REL = 'lib/python313.zip';
const CPYTHON_CACERT_REL = 'etc/ssl/cert.pem';


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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CPythonFacetResult {
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
async function cpythonRunFacetFn(
  args: Record<string, unknown>,
  facetEnv: { SUPERVISOR?: unknown } | undefined,
): Promise<CPythonFacetResult> {
  const run = Reflect.get(globalThis, '__cpythonRun') as
    ((a: unknown) => Promise<CPythonFacetResult>) | undefined;
  if (typeof run !== 'function') {
    return {
      stdout: '', stderr: '', exitCode: 127,
      error: 'cpython preamble missing: __cpythonRun not in scope',
    };
  }
  const adopt = Reflect.get(globalThis, '__wasiAdoptSupervisor') as
    ((s: unknown) => void) | undefined;
  const drain = Reflect.get(globalThis, '__wasiDrainPersist') as
    (() => Promise<void>) | undefined;
  const supervisor = facetEnv && facetEnv.SUPERVISOR;
  // Published where the boot re-adopts it after the mount: adopting only here
  // would be undone by __wasiInitFS, which clears it on purpose.
  if (supervisor) Reflect.set(globalThis, '__nimbusPySupervisor', supervisor);
  adopt?.(supervisor);
  try {
    return await run(args);
  } finally {
    // In `finally`, not on the success path: a program that wrote a file and
    // then raised still wrote the file, and those bytes are the user's.
    await drain?.();
  }
}


/**
 * Start a program that outlives the invocation, and report where it went.
 *
 * A separate dependency rather than a branch, because a resident process is a
 * property of the DEPLOYMENT and not of Python: it needs a substrate that can
 * keep an actor alive between requests and route inbound HTTP into it. A host
 * that has none does not get a degraded version — it gets none, and says so.
 */
export type CPythonResidentStart = (spawn: {
  /** VFS path of the interpreter. By path, not by value: it is 10.6 MiB. */
  wasmVfsPath: string;
  startArgs: Record<string, unknown>;
  cwd: string;
  command: string;
}) => Promise<CPythonFacetResult>;

export function makeCPythonRunnerFactory(deps: {
  facets: FacetHost;
  vfs: SqliteVFS;
  /** Where a program that keeps serving goes. See {@link CPythonResidentStart}. */
  startResident?: CPythonResidentStart;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) =>
    Command {

  return function cpythonRunnerFactory(manifest, installRoot, binName, _binKind) {
    const findFile = (rel: string): string | null => {
      const entry = manifest.files.find((f) => f.path === rel);
      return entry ? `${installRoot}/${entry.path}` : null;
    };
    const baseWasmVfs = findFile(CPYTHON_WASM_REL);
    const sciWasmVfs = findFile(CPYTHON_SCI_WASM_REL);
    const sciPackagesVfs = findFile(CPYTHON_SCI_PACKAGES_REL);
    const stdlibVfs = findFile(CPYTHON_STDLIB_REL);
    let seedCache:
      { cred: string; cwd: string; revision: number; result: ReturnType<FacetHost['seedFilesystem']> } | null = null;

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

      // Which interpreter this invocation gets. The sci variant is chosen from
      // what the session has installed, never from a guess about what this
      // program will import — the whole point of keying on state is that it is
      // also right for `python -c` naming a module in a variable. Falling back
      // when the variant is absent keeps a session installed before the variant
      // shipped working, on the base interpreter, rather than failing to start.
      const wantsSci = sessionUsesSciVariant(vfs)
        && sciWasmVfs !== null && vfs.exists(sciWasmVfs);
      const wasmVfs = wantsSci ? sciWasmVfs : baseWasmVfs;
      const sciPackagesPath = wantsSci && sciPackagesVfs && vfs.exists(sciPackagesVfs)
        ? sciPackagesVfs
        : null;

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
        PYTHON_SERVER_ADAPTER,
        'import sys',
        `sys.argv = ${JSON.stringify(pyArgv)}`,
        // The variant's own packages. zipimport reads them straight out of the
        // session filesystem, so they need no unpacking and no manifest entry
        // beyond the archive itself.
        ...(sciPackagesPath
          ? [`sys.path.insert(0, ${JSON.stringify(`/${sciPackagesPath.replace(/^\/+/, '')}`)})`]
          : []),
        `sys.path.insert(0, ${JSON.stringify(`/${PYTHON_SITE_PACKAGES_ROOT}`)})`,
        `sys.path.insert(0, ${JSON.stringify(cwd)})`,
        // WASI has no process cwd, so wasi-libc starts every guest at '/'.
        // Leaving it there silently reroutes every relative path a program
        // opens — the shell says the user is in /home/user and Python resolves
        // against the root.
        'import os',
        'try:',
        `    os.chdir(${JSON.stringify(cwd)})`,
        'except OSError:',
        '    pass',
      ].join('\n');

      const cacertVfs = findFile(CPYTHON_CACERT_REL);
      const userEnv: Record<string, string> = { ...(ctx.env || {}) };
      if (!userEnv.HOME) userEnv.HOME = '/home/user';
      if (!userEnv.PYTHONUNBUFFERED) userEnv.PYTHONUNBUFFERED = '1';
      // Without this OpenSSL has no trust anchors at all — there is no
      // /etc/ssl on a Nimbus session — and every HTTPS request fails
      // verification with a message about a missing local issuer rather than
      // about a missing bundle.
      if (!userEnv.SSL_CERT_FILE && cacertVfs) userEnv.SSL_CERT_FILE = `/${cacertVfs.replace(/^\/+/, '')}`;

      // A manifest, not a copy: sizes and modes only, with the facet demand-
      // loading whatever the program opens. The stdlib zip is covered by it
      // like any other file, which is the whole point of not having a private
      // filesystem any more.
      const stdlibDir = stdlibVfs.replace(/\/[^/]+$/, '');
      // Every runtime file the interpreter is told about has to be a root of
      // its own. The trust store was reachable only while the cwd happened to
      // be an ancestor of the install — from ~ the walk swept the whole runtime
      // tree in — so `cd` into any subdirectory and SSL_CERT_FILE pointed at a
      // path the facet could not see, and every pip install failed
      // CERTIFICATE_VERIFY_FAILED with the bundle sitting right there.
      const cacertDir = cacertVfs ? cacertVfs.replace(/\/[^/]+$/, '') : null;
      const revision = Math.max(
        vfs.revision(cwd),
        vfs.revision(PYTHON_SITE_PACKAGES_ROOT),
        vfs.revision(stdlibVfs),
      );
      let fsSeed = seedCache && seedCache.cred === credKey
        && seedCache.cwd === cwd && seedCache.revision === revision
        ? seedCache.result
        : null;
      if (!fsSeed) {
        // The host decides what "seed" means: a manifest the facet demand-loads
        // against, or the bytes themselves. Which one it is follows from
        // whether the host can park a guest mid-syscall, and nothing here
        // depends on the answer.
        fsSeed = deps.facets.seedFilesystem(vfs, cwd, {
          extraRoots: [PYTHON_SITE_PACKAGES_ROOT, stdlibDir, ...(cacertDir ? [cacertDir] : [])],
          revision,
        });
        seedCache = { cred: credKey, cwd, revision, result: fsSeed };
      }
      if ('error' in fsSeed) {
        ctx.stderr.write(`${binName}: ${fsSeed.error}\n`);
        return 1;
      }

      const snapshot = fsSeed.snapshot as unknown as {
        files: Record<string, string>; sizes?: Record<string, number>; revision?: number;
      };
      // Opened per invocation, not cached: the supervisor capability is bound
      // to this process's pid when the facet opens, so one held across calls
      // would hand every later caller the first caller's write credential.
      const facet = deps.facets.open({
        // The variant is in the tag because a host's constructor-time wasm
        // fingerprint is name:length:first-byte:last-byte, not a content hash.
        // Two variants differ by megabytes so they would not collide today, but
        // a warm slot serving the wrong interpreter is not a failure worth
        // leaving to a size coincidence.
        tag: wantsSci ? 'cpython-runner:sci' : 'cpython-runner',
        concurrency: 1,
        // Never absent. Without the capability the facet reads its seed and can
        // never write anything back — the program appears to run and its output
        // never reaches the session.
        syscalls: { vfs, pid: ctx.pid },
        preamble: buildCPythonPreamble(),
        wasmModules: { 'python.wasm': toArrayBuffer(vfs.readFile(wasmVfs)) },
      });

      const facetArgs = {
        userCode: `${prelude}\n${userCode}`,
        pyArgv,
        userEnv,
        progName,
        cwd,
        pythonHome: `/${installRoot.replace(/^\/+/, '')}`,
        supervisorPid: ctx.pid,
        fsSnapshot: snapshot,
      };

      // A script or `-m` can bind a port and keep serving, and such a program
      // is not finished when it stops producing output — it is finished when it
      // stops running. Pyodide gave those a dedicated socket process; that
      // spawn is not ported yet, so for now they get a one-shot facet with a
      // budget long enough not to cut a server off mid-request. Porting the
      // resident process is the last piece, and until it lands a server holds
      // its facet rather than being driven by inbound requests.
      const resident = shouldRunAsResidentProcess(argv, parsed, pipInvocation.mode === 'pip');

      if (resident) {
        facet.dispose();
        if (!deps.startResident) {
          ctx.stderr.write(
            `${binName}: this program keeps running after it starts, and this host has no `
            + 'process substrate to keep it on\n',
          );
          return 1;
        }
        const command = [binName, ...argv].map((part) =>
          (/^[A-Za-z0-9_./:=@+-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
        const spawnResult = await deps.startResident(
          { wasmVfsPath: wasmVfs, startArgs: facetArgs, cwd, command });
        if (spawnResult.stdout) ctx.stdout.write(spawnResult.stdout);
        if (spawnResult.stderr) ctx.stderr.write(spawnResult.stderr);
        return spawnResult.exitCode;
      }

      let result: CPythonFacetResult;
      try {
        result = await facet.submit(cpythonRunFacetFn, facetArgs, {
          timeoutMs: 120_000,
        });
      } catch (e: unknown) {
        ctx.stderr.write(`${binName}: ${errorMessage(e)}\n`);
        return 1;
      } finally {
        facet.dispose();
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
