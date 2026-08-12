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
import { resolveVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { z } from 'zod/v4';
import { hasLeadingCliFlag } from '@nimbus-sh/core/runtime/cli-flags.js';
import { CPYTHON_PREAMBLE_TAIL } from '@nimbus-sh/core/runtime/cpython-preamble.js';
import { PYTHON_SERVER_ADAPTER } from '@nimbus-sh/core/runtime/python-server-adapter.js';
import { getFacetManagerLoaderHost } from './facet-loader-host.js';
import { requireVfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { buildPipInvocation, PYTHON_SITE_PACKAGES_ROOT, sessionUsesSciVariant, } from './python-pip.js';
import { manifestVfs } from '@nimbus-sh/core/runtime/vfs-manifest.js';
import { VIRTUAL_SOCKET_KERNEL_SRC } from './virtual-socket-kernel.generated.js';
import { WASI_INSTANCE_PREAMBLE_SRC } from '@nimbus-sh/core/runtime/wasi-instance.js';
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
export function buildCPythonPreamble() {
    return [
        VIRTUAL_SOCKET_KERNEL_SRC,
        WASI_INSTANCE_PREAMBLE_SRC,
        CPYTHON_PREAMBLE_TAIL,
    ].join('\n');
}
/**
 * Python's CLI, as far as a sandbox needs it. Flags that only affect an
 * interactive tty or bytecode caching are accepted and ignored; anything else
 * is refused by name rather than silently doing something different.
 */
function parsePythonArgv(argv) {
    const fail = (error) => ({ mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [], exitCode: 2, error });
    let i = 0;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '-c') {
            const code = argv[i + 1];
            if (code === undefined)
                return fail('Argument expected for the -c option');
            return { mode: 'inline', inlineCode: code, scriptPath: '', scriptArgs: argv.slice(i + 2), exitCode: 0 };
        }
        if (a === '-m') {
            const mod = argv[i + 1];
            if (mod === undefined)
                return fail('Argument expected for the -m option');
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
        if (/^-[OBuEItcsx]+$/.test(a)) {
            i++;
            continue;
        }
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
function shouldRunAsResidentProcess(argv, parsed, pipMode) {
    if (pipMode)
        return false;
    if (parsed.mode === 'script')
        return true;
    if (argv[0] === '-m' && argv[1] && argv[1] !== 'pip')
        return true;
    return false;
}
/** `python -m pip ...` is pip, reached the long way round. */
async function buildPythonModulePipInvocation(argv, cwd, vfs, runtimeContext) {
    if (argv[0] !== '-m' || argv[1] !== 'pip')
        return { mode: 'none', code: '', exitCode: 0 };
    return await buildPipInvocation(argv.slice(2), 'pip', cwd, vfs, runtimeContext);
}
function toArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * The worker source for a resident Python process. Same shape as
 * buildRubySocketProcessWorker: the socket kernel and the interpreter live in a
 * DurableObject, startProcess runs the program until it stops, and inbound
 * requests arrive on handleHttpRequest and are dispatched into the server the
 * program registered before exiting.
 */
export function buildCPythonSocketProcessWorker(preamble) {
    return [
        'import { DurableObject } from "cloudflare:workers";',
        // The module arrives by path (vfsWasmModules) and has to be published where
        // the preamble looks for it. Without this the facet boots and the first
        // thing it says is "python.wasm was not supplied to this facet".
        "import __NIMBUS_WASM_python from './python.wasm';",
        'globalThis.__NIMBUS_WASM = globalThis.__NIMBUS_WASM || {};',
        "globalThis.__NIMBUS_WASM['python.wasm'] = __NIMBUS_WASM_python;",
        '',
        preamble,
        '',
        // Only adopt a real binding: routed fetch hops resolve the entrypoint
        // without a supervisor, and overwriting with undefined would drop the live
        // stub the process needs for its whole lifetime.
        'function __nimbusAdoptPySupervisor(env) {',
        '  const supervisor = env && env.SUPERVISOR;',
        '  if (supervisor) globalThis.__nimbusPySupervisor = supervisor;',
        '  __wasiAdoptSupervisor(supervisor);',
        '}',
        // A resident process answers between requests, and that is the only moment
        // "durable while running" can be made true: by the time the caller holds a
        // response, everything the request wrote has reached the VFS.
        'async function __nimbusParkPy(value) {',
        '  await __wasiDrainPersist();',
        '  await __wasiRevalidateFS();',
        '  return value;',
        '}',
        'async function __nimbusStartPyProcess(args) {',
        '  const result = await globalThis.__cpythonStartProcess(args || {});',
        '  const ports = await globalThis.__cpythonListeningPorts();',
        '  const registrations = globalThis.__nimbusVirtualPortRegistrationPromises || [];',
        '  if (registrations.length > 0) await Promise.allSettled(registrations.splice(0));',
        '  if (ports.length > 0) {',
        '    return { state: "listening", port: ports[0], stdout: result.stdout, stderr: result.stderr };',
        '  }',
        '  return { state: "exited", result, stdout: result.stdout, stderr: result.stderr };',
        '}',
        'export class NimbusProcess extends DurableObject {',
        '  async startProcess(args) {',
        '    __nimbusAdoptPySupervisor(this.env);',
        '    return __nimbusParkPy(await __nimbusStartPyProcess(args || {}));',
        '  }',
        '  async fetch(request) {',
        '    __nimbusAdoptPySupervisor(this.env);',
        '    return this.handleHttpRequest(request);',
        '  }',
        '  async handleHttpRequest(request) {',
        '    __nimbusAdoptPySupervisor(this.env);',
        '    const hinted = Number(request.headers.get("X-Nimbus-Port") || 0);',
        '    const port = hinted || Array.from(globalThis.__nimbusVirtualSockets.listeners.keys())[0];',
        '    if (!port) return new Response("Nimbus Python process has no listening virtual socket", { status: 502 });',
        '    return __nimbusParkPy(await globalThis.__nimbusVirtualSockets.handleHttpRequest(port, request));',
        '  }',
        '}',
    ].join('\n');
}
const CPythonBootSchema = z.object({
    state: z.string().optional(),
    port: z.number().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    result: z.object({ exitCode: z.number().optional() }).passthrough().optional(),
}).passthrough();
/**
 * Facet-side entry. Serialized with fn.toString(), so it captures nothing and
 * names no import: everything it needs is on globalThis, put there by the
 * preamble.
 */
async function cpythonRunFacetFn(args, facetEnv) {
    const run = Reflect.get(globalThis, '__cpythonRun');
    if (typeof run !== 'function') {
        return {
            stdout: '', stderr: '', exitCode: 127,
            error: 'cpython preamble missing: __cpythonRun not in scope',
        };
    }
    const adopt = Reflect.get(globalThis, '__wasiAdoptSupervisor');
    const drain = Reflect.get(globalThis, '__wasiDrainPersist');
    const supervisor = facetEnv && facetEnv.SUPERVISOR;
    // Published where the boot re-adopts it after the mount: adopting only here
    // would be undone by __wasiInitFS, which clears it on purpose.
    if (supervisor)
        Reflect.set(globalThis, '__nimbusPySupervisor', supervisor);
    adopt?.(supervisor);
    try {
        return await run(args);
    }
    finally {
        // In `finally`, not on the success path: a program that wrote a file and
        // then raised still wrote the file, and those bytes are the user's.
        await drain?.();
    }
}
/**
 * Start a program that binds a port as its own process, so it outlives the
 * invocation that started it. Mirrors spawnRubySocketProcess.
 */
async function spawnCPythonSocketProcess(facetMgr, args, command) {
    const workerCode = buildCPythonSocketProcessWorker(buildCPythonPreamble());
    const spawned = await facetMgr.spawnWorker(workerCode, command, args.cwd, {
        compatibilityFlags: ['nodejs_compat'],
        // By path, not by value: the interpreter is 10.6 MiB, more than a single
        // RPC value may carry, so whichever host runs this process reads it itself.
        vfsWasmModules: { 'python.wasm': args.wasmVfsPath },
        startArgs: args.startArgs,
    }).catch(() => null);
    if (!spawned)
        return { exitCode: 1, stdout: '', stderr: 'python process boot failed\n' };
    const boot = CPythonBootSchema.safeParse(spawned.boot);
    if (!boot.success) {
        facetMgr.finishProcess(spawned.pid, 1, 'python process boot failed');
        return { exitCode: 1, stdout: '', stderr: 'python process boot failed\n' };
    }
    const data = boot.data;
    if (data.state === 'listening' && typeof data.port === 'number' && data.port > 0) {
        facetMgr.registerPort(spawned.pid, data.port);
        const routeable = await facetMgr.waitForRouteablePorts(spawned.pid);
        const port = routeable.includes(data.port) ? data.port : routeable[0];
        if (!port) {
            facetMgr.kill(spawned.pid);
            return {
                exitCode: 1,
                stdout: data.stdout || '',
                stderr: `${data.stderr || ''}python: virtual socket port ${data.port} failed to attach a route handler\n`,
            };
        }
        return {
            exitCode: 0,
            stdout: `${data.stdout || ''}\x1b[2m[started (long-running): pid=${spawned.pid} cmd="${command}" port=${port}]\x1b[0m\n`,
            stderr: data.stderr || '',
            spawnedPid: spawned.pid,
            port,
        };
    }
    const result = data.result;
    const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : 0;
    facetMgr.finishProcess(spawned.pid, exitCode, data.stderr || 'python process exited');
    return { exitCode, stdout: data.stdout || '', stderr: data.stderr || '' };
}
export function makeCPythonRunnerFactory(deps) {
    const { facetMgr } = deps;
    return function cpythonRunnerFactory(manifest, installRoot, binName, _binKind) {
        const findFile = (rel) => {
            const entry = manifest.files.find((f) => f.path === rel);
            return entry ? `${installRoot}/${entry.path}` : null;
        };
        const baseWasmVfs = findFile(CPYTHON_WASM_REL);
        const sciWasmVfs = findFile(CPYTHON_SCI_WASM_REL);
        const sciPackagesVfs = findFile(CPYTHON_SCI_PACKAGES_REL);
        const stdlibVfs = findFile(CPYTHON_STDLIB_REL);
        let manifestCache = null;
        return async function cpythonBinHandler(ctx) {
            const cred = requireVfsCred(ctx.cred, binName);
            const credKey = `${cred.uid}:${cred.gid}:${cred.groups.join(',')}`;
            const vfs = deps.vfs.as(cred);
            const argv = ctx.args || [];
            const cwd = ctx.cwd || '/home/user';
            const pipRuntimeContext = {
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
            const parsed = pipInvocation.mode === 'pip'
                ? { mode: 'inline', inlineCode: pipInvocation.code, scriptPath: '', scriptArgs: [], exitCode: 0 }
                : parsePythonArgv(argv);
            if (parsed.error) {
                ctx.stderr.write(`${binName}: ${parsed.error}\n`);
                return parsed.exitCode;
            }
            let userCode = '';
            let progName = binName;
            let pyArgv = [binName];
            if (parsed.mode === 'inline') {
                userCode = parsed.inlineCode;
                pyArgv = ['-c', ...parsed.scriptArgs];
            }
            else if (parsed.mode === 'script') {
                const absPath = resolveVfsPath(parsed.scriptPath, cwd);
                try {
                    if (!vfs.exists(absPath)) {
                        ctx.stderr.write(`${binName}: can't open file '${parsed.scriptPath}': [Errno 2] No such file or directory\n`);
                        return 2;
                    }
                    userCode = new TextDecoder('utf-8').decode(vfs.readFile(absPath));
                }
                catch (e) {
                    ctx.stderr.write(`${binName}: ${parsed.scriptPath}: ${errorMessage(e)}\n`);
                    return 1;
                }
                progName = parsed.scriptPath;
                pyArgv = [parsed.scriptPath, ...parsed.scriptArgs];
            }
            else {
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
            const userEnv = { ...(ctx.env || {}) };
            if (!userEnv.HOME)
                userEnv.HOME = '/home/user';
            if (!userEnv.PYTHONUNBUFFERED)
                userEnv.PYTHONUNBUFFERED = '1';
            // Without this OpenSSL has no trust anchors at all — there is no
            // /etc/ssl on a Nimbus session — and every HTTPS request fails
            // verification with a message about a missing local issuer rather than
            // about a missing bundle.
            if (!userEnv.SSL_CERT_FILE && cacertVfs)
                userEnv.SSL_CERT_FILE = `/${cacertVfs.replace(/^\/+/, '')}`;
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
            const revision = Math.max(vfs.revision(cwd), vfs.revision(PYTHON_SITE_PACKAGES_ROOT), vfs.revision(stdlibVfs));
            let fsManifest = manifestCache && manifestCache.cred === credKey
                && manifestCache.cwd === cwd && manifestCache.revision === revision
                ? manifestCache.result
                : null;
            if (!fsManifest) {
                fsManifest = manifestVfs(vfs, cwd, {
                    extraRoots: [PYTHON_SITE_PACKAGES_ROOT, stdlibDir, ...(cacertDir ? [cacertDir] : [])],
                    revision,
                });
                manifestCache = { cred: credKey, cwd, revision, result: fsManifest };
            }
            if ('error' in fsManifest) {
                ctx.stderr.write(`${binName}: ${fsManifest.error}\n`);
                return 1;
            }
            const snapshot = fsManifest.snapshot;
            // Built per invocation, not cached: supervisorPid is baked into the
            // SUPERVISOR binding at construction, so a pool held across calls would
            // hand every later caller the first caller's write credential.
            const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
            const host = getFacetManagerLoaderHost(facetMgr);
            const pool = new NimbusLoaderPool(host.env, host.ctx, {
                // The variant is in the tag because the pool's constructor-time wasm
                // fingerprint is name:length:first-byte:last-byte, not a content hash.
                // Two variants differ by megabytes so they would not collide today, but
                // a warm slot serving the wrong interpreter is not a failure worth
                // leaving to a size coincidence.
                tag: wantsSci ? 'cpython-runner:sci' : 'cpython-runner',
                concurrency: 1,
                // NOT omitSupervisor. Without it the facet reads the seeded manifest
                // and can never write anything back — the program appears to run and
                // its output never reaches the session.
                supervisorPid: ctx.pid,
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
                const command = [binName, ...argv].map((part) => (/^[A-Za-z0-9_./:=@+-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
                const spawnResult = await spawnCPythonSocketProcess(facetMgr, { wasmVfsPath: wasmVfs, startArgs: facetArgs, cwd }, command);
                if (spawnResult.stdout)
                    ctx.stdout.write(spawnResult.stdout);
                if (spawnResult.stderr)
                    ctx.stderr.write(spawnResult.stderr);
                return spawnResult.exitCode;
            }
            let result;
            try {
                result = await pool.submit(cpythonRunFacetFn, facetArgs, {
                    timeoutMs: 120_000,
                });
            }
            catch (e) {
                ctx.stderr.write(`${binName}: ${errorMessage(e)}\n`);
                return 1;
            }
            if (result.stdout)
                ctx.stdout.write(result.stdout);
            if (result.stderr)
                ctx.stderr.write(result.stderr);
            if (result.error) {
                ctx.stderr.write(`${binName}: ${result.error}\n`);
                return result.exitCode || 1;
            }
            return result.exitCode;
        };
    };
}
