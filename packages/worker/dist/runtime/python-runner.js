/**
 * python-runner.ts — Pyodide v0.29.4 runner (runtime package manager v2 / Pyodide v1).
 *
 * D1-D7:
 *   - `python --version` / `python -c '<code>'` / `python script.py`
 *   - stdlib subset (full python_stdlib.zip ships)
 *   - stdout/stderr → the process supervisor's log ring (Process tab integration)
 *   - exit code via sys.exit(N) or unhandled exception → 1
 *   - argv passed through to sys.argv
 *
 * Current limits:
 *   - REPL mode (`python` with no args)
 *   - Native Linux wheels, undeclared extension modules, and extension builds
 *   - Sync HTTP (urllib3 / requests blocked without JSPI)
 *
 * Architecture: SAME LOADER-modules transport as clang-runner/wasm-
 * runner. The Pyodide wasm bytes ship via the LOADER `modules` map
 * (CSP allows wasm code-gen at module-load time, not at request
 * time). The workerd-adapted Pyodide.asm.js artifact and stdlib zip are
 * embedded in the generated facet preamble.
 *
 * Per wasm-csp/findings.md §4b: Pyodide.asm.wasm (10.1 MB on disk)
 * compiles in 314 ms via LOADER on PROD. With our v1 deployment of
 * 0.29.4 (8.25 MB asm.wasm), this is well under the empirical
 * ~32 MiB per-call ceiling.
 */
import { isRuntimePythonPackageArtifactMetadata, sha256Hex, } from './runtime-catalog.js';
import { flushVfsDiff, snapshotVfs } from './vfs-snapshot.js';
import { resolveVfsPath } from '../vfs/path.js';
import { ESBUILD_NAME_GLOBAL_SHIM } from '../_shared/esbuild-facet-shim.js';
import { VIRTUAL_SOCKET_KERNEL_SRC } from './virtual-socket-kernel.generated.js';
import { PYTHON_SOCKET_SHIM } from './python-socket-shim.js';
import { readPyodideRuntimeFiles } from './pyodide-runtime-assets.js';
import { buildPipInvocation, parseInstalledPyodidePackageManifest, PYTHON_PYODIDE_PACKAGE_MANIFEST, PYTHON_SITE_PACKAGES_ROOT, } from './python-pip.js';
import { z } from 'zod/v4';
import { hasLeadingCliFlag } from './cli-flags.js';
import { requireVfsCred } from './os-contracts.js';
const PYTHON_VERSION_FLAGS = new Set(['--version', '-V']);
const PYTHON_HELP_FLAGS = new Set(['--help', '-h']);
export function expandPythonEffectiveMode(effective) {
    const bits = effective & 0o7;
    return (bits << 6) | (bits << 3) | bits;
}
export function installPythonFsSnapshot(fs, snapshot, previousFiles = new Set()) {
    // The interactive REPL boots its facet without a filesystem snapshot
    // (python-repl.ts init dispatches __pyodideRun with no fsSnapshot).
    // Absence means nothing to mount or unmount; keep the ledger as-is.
    if (!snapshot)
        return new Set(previousFiles);
    const norm = (path) => {
        const clean = String(path || '').replace(/^\/+/, '').replace(/\/+$/, '');
        return clean ? `/${clean}` : '/';
    };
    const decode = (encoded) => {
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++)
            bytes[index] = binary.charCodeAt(index);
        return bytes;
    };
    const directories = new Set(snapshot.dirs || []);
    const currentFiles = new Set(Object.keys(snapshot.modes || {}).filter((path) => !directories.has(path)));
    for (const previous of previousFiles) {
        if (currentFiles.has(previous))
            continue;
        const absolute = norm(previous);
        if (fs.analyzePath(absolute).exists)
            fs.unlink(absolute);
    }
    for (const directory of [...directories].sort((a, b) => a.length - b.length)) {
        fs.mkdirTree(norm(directory));
    }
    for (const path of currentFiles) {
        const absolute = norm(path);
        const parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/';
        fs.mkdirTree(parent);
        const encoded = snapshot.files?.[path];
        fs.writeFile(absolute, encoded === undefined ? new Uint8Array() : decode(encoded));
        fs.chmod(absolute, expandPythonEffectiveMode(snapshot.modes[path]));
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
        const mode = snapshot.modes?.[directory];
        if (mode !== undefined)
            fs.chmod(norm(directory), expandPythonEffectiveMode(mode));
    }
    return currentFiles;
}
/**
 * Build the python-runner factory. Called once at session init; the
 * returned factory binds the manifest + install root for each
 * registered entrypoint (`python`, `python3`).
 */
export function makePythonRunnerFactory(deps) {
    const { facetMgr } = deps;
    return function pythonRunnerFactory(manifest, installRoot, binName, binKind) {
        const findFile = (rel) => {
            const entry = manifest.files.find((f) => f.path === rel);
            return entry ? `${installRoot}/${entry.path}` : null;
        };
        const asmWasmVfs = findFile('share/pyodide/pyodide.asm.wasm');
        const asmJsVfs = findFile('share/pyodide/pyodide.asm.js');
        const stdlibVfs = findFile('share/pyodide/python_stdlib.zip');
        const lockfileVfs = findFile('share/pyodide/pyodide-lock.json');
        let runtimePromise = null;
        let fsSnapshotCache = null;
        return async function pythonBinHandler(ctx) {
            const cred = requireVfsCred(ctx.cred, binName);
            const credKey = `${cred.uid}:${cred.gid}:${cred.groups.join(',')}`;
            const vfs = deps.vfs.as(cred);
            const pipRuntimeContext = {
                pyodideLockfileText: lockfileVfs && vfs.exists(lockfileVfs)
                    ? new TextDecoder('utf-8').decode(vfs.readFile(lockfileVfs))
                    : null,
                runtimeArtifacts: manifest.runtime_artifacts || [],
            };
            const argv = ctx.args || [];
            const cwd = ctx.cwd || '/home/user';
            const pipInvocation = binKind === 'pip' || binName === 'pip' || binName === 'pip3'
                ? await buildPipInvocation(argv, binName, cwd, vfs, pipRuntimeContext)
                : await buildPythonModulePipInvocation(argv, cwd, vfs, pipRuntimeContext);
            if (pipInvocation.error) {
                ctx.stderr.write(`${binName}: ${pipInvocation.error}\n`);
                return pipInvocation.exitCode;
            }
            // ── --version / --help fast paths (no wasm boot) ─────────────
            if (pipInvocation.mode !== 'pip' && hasLeadingCliFlag(argv, PYTHON_VERSION_FLAGS)) {
                ctx.stdout.write(`Python 3.13.2 (Pyodide 0.29.4, Nimbus runtime)\n`);
                return 0;
            }
            if (pipInvocation.mode !== 'pip' && hasLeadingCliFlag(argv, PYTHON_HELP_FLAGS)) {
                ctx.stdout.write(`usage: ${binName} [option] ... [-c cmd | -m mod | file | -] [arg] ...\n`);
                ctx.stdout.write(`Nimbus Pyodide 0.29.4 / Python 3.13 runtime.\n`);
                ctx.stdout.write(`Supported: -c <code>, -m <module>, <file.py>, stdin via -, VFS-backed imports and file IO\n`);
                ctx.stdout.write(`Package support is limited to pure Python wheels and source packages; native Linux wheels and runtime-loaded extension modules are not executable in Nimbus yet.\n`);
                return 0;
            }
            // ── Resolve install bytes ────────────────────────────────────
            if (!asmWasmVfs || !vfs.exists(asmWasmVfs)) {
                ctx.stderr.write(`${binName}: pyodide.asm.wasm missing (re-run 'nimbus install python')\n`);
                return 127;
            }
            if (!asmJsVfs || !vfs.exists(asmJsVfs)) {
                ctx.stderr.write(`${binName}: pyodide.asm.js missing\n`);
                return 127;
            }
            if (!stdlibVfs || !vfs.exists(stdlibVfs)) {
                ctx.stderr.write(`${binName}: python_stdlib.zip missing\n`);
                return 127;
            }
            // ── Parse argv ───────────────────────────────────────────────
            // Supported in v1:
            //   python -c '<code>'           run inline code, args[i+1..] in sys.argv
            //   python <file.py> [args...]   run script, args in sys.argv
            //   python                       (no args) → not supported; REPL is v2
            //   python -                     read code from stdin (advanced)
            const parsed = pipInvocation.mode === 'pip'
                ? {
                    mode: 'inline',
                    inlineCode: pipInvocation.code,
                    scriptPath: '',
                    scriptArgs: [],
                    exitCode: 0,
                }
                : parsePythonArgv(argv);
            if (parsed.error) {
                ctx.stderr.write(`${binName}: ${parsed.error}\n`);
                return parsed.exitCode;
            }
            let sideModules;
            try {
                sideModules = await collectPythonSideModules(vfs, installRoot, manifest, pipInvocation.pyodidePackages || []);
            }
            catch (e) {
                ctx.stderr.write(`${binName}: ${e instanceof Error ? e.message : String(e)}\n`);
                return 1;
            }
            // For -c mode: code comes from argv. For script-file mode:
            // read from VFS. For stdin mode: we collect stdin upfront.
            let userCode = '';
            let progName = binName;
            let pyArgv = [binName];
            if (parsed.mode === 'inline') {
                userCode = parsed.inlineCode;
                pyArgv = ['-c', ...parsed.scriptArgs];
            }
            else if (parsed.mode === 'script') {
                // Read script from VFS, resolving relative to cwd.
                const absPath = resolveVfsPath(parsed.scriptPath, cwd);
                try {
                    if (!vfs.exists(absPath)) {
                        ctx.stderr.write(`${binName}: ${parsed.scriptPath}: No such file or directory\n`);
                        return 2;
                    }
                    userCode = new TextDecoder('utf-8').decode(vfs.readFile(absPath));
                }
                catch (e) {
                    ctx.stderr.write(`${binName}: ${parsed.scriptPath}: ${e instanceof Error ? e.message : String(e)}\n`);
                    return 1;
                }
                progName = parsed.scriptPath;
                pyArgv = [parsed.scriptPath, ...parsed.scriptArgs];
            }
            else if (parsed.mode === 'stdin') {
                // Read all of stdin from ctx after the shell pipeline fills it.
                // Pyodide receives it as the program source.
                const stdinReader = ctx.stdin;
                if (stdinReader && typeof stdinReader.read === 'function') {
                    // The shell's ctx.stdin is a stream-like with .read() that
                    // returns the accumulated buffer up to EOF. Lifo-sh's pipe
                    // implementation feeds the upstream's stdout into this.
                    userCode = await stdinReader.read();
                }
                else {
                    // No piped stdin → empty program.
                    userCode = '';
                }
                pyArgv = ['-', ...parsed.scriptArgs];
            }
            // env passed to Python's os.environ. We forward NIMBUS_*,
            // PATH-ish, and a default HOME if not set.
            const userEnv = { ...(ctx.env || {}) };
            if (!userEnv.HOME)
                userEnv.HOME = '/home/user';
            if (!userEnv.PYTHONUNBUFFERED)
                userEnv.PYTHONUNBUFFERED = '1';
            // Per-subtree watermark over exactly what the snapshot covers (cwd +
            // site-packages), so unrelated VFS writes don't evict the cache.
            const revision = Math.max(vfs.revision(cwd), vfs.revision(PYTHON_SITE_PACKAGES_ROOT));
            let fsSnapshot = fsSnapshotCache && fsSnapshotCache.cred === credKey
                && fsSnapshotCache.cwd === cwd && fsSnapshotCache.revision === revision
                ? fsSnapshotCache.result
                : null;
            if (!fsSnapshot) {
                fsSnapshot = snapshotVfs(vfs, cwd, { extraRoots: [PYTHON_SITE_PACKAGES_ROOT] });
                fsSnapshotCache = { cred: credKey, cwd, revision, result: fsSnapshot };
            }
            if ('error' in fsSnapshot) {
                ctx.stderr.write(`${binName}: ${fsSnapshot.error}\n`);
                return 1;
            }
            if (shouldRunPythonAsSocketProcess(argv, parsed, pipInvocation.mode === 'pip')) {
                const result = await spawnPythonSocketProcess(facetMgr, {
                    asmWasmVfs,
                    asmJsVfs,
                    stdlibVfs,
                    lockfileVfs,
                    manifest,
                    vfs,
                }, sideModules, {
                    userCode,
                    pyArgv,
                    userEnv,
                    progName,
                    cwd,
                    fsSnapshot: fsSnapshot.snapshot,
                    asyncRun: true,
                }, formatPythonCommand(binName, argv));
                if (result.stdout)
                    ctx.stdout.write(result.stdout);
                if (result.stderr)
                    ctx.stderr.write(result.stderr);
                if (result.fsDiff)
                    flushVfsDiff(vfs, result.fsDiff);
                return result.exitCode;
            }
            // ── Dispatch the facet ───────────────────────────────────────
            let runtime;
            try {
                const runtimeKey = `${credKey}|${sideModules.modules.map((mod) => `${mod.moduleKey}:${mod.packageId}`).sort().join('|')}`;
                if (!runtimePromise || runtimePromise.key !== runtimeKey) {
                    runtimePromise = {
                        key: runtimeKey,
                        promise: createPythonFacetRuntime(facetMgr, {
                            asmWasmVfs,
                            asmJsVfs,
                            stdlibVfs,
                            lockfileVfs,
                            manifest,
                            vfs,
                        }, sideModules),
                    };
                }
                runtime = await runtimePromise.promise;
            }
            catch (e) {
                runtimePromise = null;
                ctx.stderr.write(`${binName}: python runtime warm-up failed: ${e?.message || e}\n`);
                return 1;
            }
            const result = await dispatchPythonFacet(runtime, {
                userCode,
                pyArgv,
                userEnv,
                progName,
                cwd,
                fsSnapshot: fsSnapshot.snapshot,
                asyncRun: pipInvocation.mode === 'pip',
            });
            if (result.stdout)
                ctx.stdout.write(result.stdout);
            if (result.stderr)
                ctx.stderr.write(result.stderr);
            if (result.fsDiff)
                flushVfsDiff(vfs, result.fsDiff);
            if (result.error) {
                ctx.stderr.write(`${binName}: ${result.error}\n`);
                return 1;
            }
            return result.exitCode;
        };
    };
}
async function buildPythonModulePipInvocation(argv, cwd, vfs, runtimeContext) {
    if (argv[0] !== '-m' || argv[1] !== 'pip') {
        return { mode: 'none', code: '', exitCode: 0 };
    }
    return await buildPipInvocation(argv.slice(2), 'pip', cwd, vfs, runtimeContext);
}
function parsePythonArgv(argv) {
    // Walk argv left-to-right looking for the first non-flag token OR
    // the -c / -m mode-switches. Python's CLI is more involved (-O,
    // -B, -E, -W, -I, etc.) but for v1 we accept and ignore unknown
    // single-letter flags that don't take args, and error loudly on
    // unsupported ones.
    let i = 0;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '-c') {
            const code = argv[i + 1];
            if (code === undefined) {
                return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [], exitCode: 2,
                    error: "Argument expected for the -c option" };
            }
            return {
                mode: 'inline',
                inlineCode: code,
                scriptPath: '',
                scriptArgs: argv.slice(i + 2),
                exitCode: 0,
            };
        }
        if (a === '-m') {
            const mod = argv[i + 1];
            if (mod === undefined) {
                return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [], exitCode: 2,
                    error: "Argument expected for the -m option" };
            }
            // -m <mod> [args...]  →  runpy.run_module(mod)
            const inlineCode = `import runpy, sys\nsys.argv = ${JSON.stringify([mod, ...argv.slice(i + 2)])}\nrunpy.run_module(${JSON.stringify(mod)}, run_name='__main__', alter_sys=True)\n`;
            return {
                mode: 'inline',
                inlineCode,
                scriptPath: '',
                scriptArgs: argv.slice(i + 2),
                exitCode: 0,
            };
        }
        if (a === '-') {
            return { mode: 'stdin', inlineCode: '', scriptPath: '-', scriptArgs: argv.slice(i + 1), exitCode: 0 };
        }
        if (!a.startsWith('-')) {
            return {
                mode: 'script',
                inlineCode: '',
                scriptPath: a,
                scriptArgs: argv.slice(i + 1),
                exitCode: 0,
            };
        }
        // Unknown flag — for v1, silently skip single-char flags that
        // are commonly harmless (-O, -B, -u, -E, -I). Error on others.
        if (/^-[OBuEItcsx]+$/.test(a)) {
            i++;
            continue;
        }
        return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [], exitCode: 2,
            error: `unknown option: ${a}` };
    }
    // No mode argument provided — REPL is not supported in v1.
    return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [], exitCode: 2,
        error: "REPL not supported in v1. Use 'python -c \"code\"' or 'python script.py'." };
}
function buildPythonRuntimeAssets(args, sideModules = EMPTY_PYTHON_SIDE_MODULE_SET) {
    const files = readPyodideRuntimeFiles(args);
    return {
        asmWasmBytes: files.asmWasmBytes,
        preamble: buildPyodidePreamble(files.asmJsSrc, files.stdlibB64, files.lockfileText, sideModules.resolverEntries),
    };
}
const EMPTY_PYTHON_SIDE_MODULE_SET = {
    modules: [],
    wasmModules: {},
    resolverEntries: [],
};
async function collectPythonSideModules(vfs, installRoot, manifest, additionalArtifacts) {
    const runtimeArtifacts = runtimePythonPackageArtifacts(manifest);
    if (runtimeArtifacts.length === 0 && additionalArtifacts.length === 0) {
        return EMPTY_PYTHON_SIDE_MODULE_SET;
    }
    const byId = new Map(runtimeArtifacts.map((artifact) => [artifact.id, artifact]));
    const artifacts = new Map();
    for (const artifact of readInstalledPyodideArtifacts(vfs, byId)) {
        artifacts.set(artifact.id, artifact);
    }
    for (const artifact of additionalArtifacts) {
        const runtimeArtifact = byId.get(artifact.id);
        if (!runtimeArtifact) {
            throw new Error(`Pyodide package artifact '${artifact.id}' is not present in the installed Python runtime manifest`);
        }
        artifacts.set(runtimeArtifact.id, runtimeArtifact);
    }
    const modules = [];
    const wasmModules = {};
    const resolverEntries = [];
    for (const artifact of artifacts.values()) {
        for (let i = 0; i < artifact.extensionModules.length; i++) {
            const extension = artifact.extensionModules[i];
            const moduleKey = pythonSideModuleKey(artifact, extension, i);
            const runtimePath = `${installRoot}/${extension.runtimePath}`;
            if (!vfs.exists(runtimePath)) {
                throw new Error(`${artifact.packageName}: startup module missing from runtime install: ${extension.runtimePath}`);
            }
            const bytes = vfs.readFile(runtimePath);
            const actualSha256 = await sha256Hex(bytes);
            if (actualSha256 !== extension.sha256.toLowerCase()) {
                throw new Error(`${artifact.packageName}: startup module hash mismatch for ${extension.path}`);
            }
            const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            wasmModules[moduleKey] = arrayBuffer;
            modules.push({
                packageId: artifact.id,
                packageName: artifact.packageName,
                version: artifact.version,
                sitePath: extension.path,
                moduleKey,
                runtimePath: extension.runtimePath,
                bytes: arrayBuffer,
            });
            resolverEntries.push({
                packageId: artifact.id,
                packageName: artifact.packageName,
                version: artifact.version,
                sitePath: extension.path,
                moduleKey,
            });
        }
    }
    return { modules, wasmModules, resolverEntries };
}
function runtimePythonPackageArtifacts(manifest) {
    return (manifest.runtime_artifacts || []).filter(isRuntimePythonPackageArtifactMetadata);
}
function readInstalledPyodideArtifacts(vfs, runtimeArtifactsById) {
    if (!vfs.exists(PYTHON_PYODIDE_PACKAGE_MANIFEST))
        return [];
    const text = new TextDecoder('utf-8').decode(vfs.readFile(PYTHON_PYODIDE_PACKAGE_MANIFEST));
    let parsed;
    try {
        parsed = parseInstalledPyodidePackageManifest(text);
    }
    catch (e) {
        throw new Error(`installed Pyodide package manifest is invalid: ${e instanceof Error ? e.message : String(e)}`);
    }
    const out = [];
    for (const installed of parsed.packages) {
        const artifact = runtimeArtifactsById.get(installed.id);
        if (!artifact) {
            throw new Error(`installed Pyodide package '${installed.id}' is not available in this Python runtime`);
        }
        out.push(artifact);
    }
    return out;
}
function pythonSideModuleKey(artifact, extension, index) {
    return `pyodide-side-modules/${artifact.packageName}/${artifact.version}/${index}-${extension.sha256.slice(0, 16)}.wasm`;
}
function wasmImportIdentifier(moduleKey) {
    return moduleKey.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z_]/, '_');
}
async function dispatchPythonFacet(runtime, args) {
    // v2 simplification: stdlibB64 and asmWasmMod are now embedded in the
    // preamble (stdlib via base64 splice; wasm via __NIMBUS_WASM table set
    // by the loader-pool). The facet fn only needs the per-call inputs.
    const facetFn = async function pythonFacetCall(inArgs) {
        const fn = globalThis.__pyodideRun;
        if (typeof fn !== 'function') {
            return { exitCode: 127, stdout: '', stderr: '',
                error: 'python-runner preamble missing: __pyodideRun not in scope' };
        }
        return await fn({
            userCode: inArgs.userCode,
            pyArgv: inArgs.pyArgv,
            userEnv: inArgs.userEnv,
            progName: inArgs.progName,
            cwd: inArgs.cwd,
            fsSnapshot: inArgs.fsSnapshot,
            asyncRun: !!inArgs.asyncRun,
        });
    };
    try {
        const result = await runtime.pool.submit(facetFn, {
            userCode: args.userCode,
            pyArgv: args.pyArgv,
            userEnv: args.userEnv,
            progName: args.progName,
            cwd: args.cwd,
            fsSnapshot: args.fsSnapshot,
            asyncRun: !!args.asyncRun,
        }, {
            timeoutMs: 300_000,
        });
        return {
            exitCode: result.exitCode,
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            error: result.error,
            fsDiff: result.fsDiff,
        };
    }
    catch (e) {
        return {
            exitCode: 1,
            stdout: '',
            stderr: '',
            error: `python-runner dispatch failed: ${e?.message || e}`,
        };
    }
}
const PythonSocketProcessBootResultSchema = z.object({
    exitCode: z.number().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    error: z.string().optional(),
    fsDiff: z.custom().optional(),
}).passthrough();
const PythonSocketProcessBootResponseSchema = z.object({
    state: z.string().optional(),
    port: z.number().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    result: PythonSocketProcessBootResultSchema.optional(),
}).passthrough();
function shouldRunPythonAsSocketProcess(argv, parsed, pipMode) {
    if (pipMode)
        return false;
    if (parsed.mode === 'script')
        return true;
    if (argv[0] === '-m' && argv[1] && argv[1] !== 'pip')
        return true;
    return false;
}
function formatPythonCommand(binName, argv) {
    return [binName, ...argv].map((part) => {
        if (/^[A-Za-z0-9_./:=@+-]+$/.test(part))
            return part;
        return JSON.stringify(part);
    }).join(' ');
}
async function spawnPythonSocketProcess(facetMgr, assetPaths, sideModules, args, command) {
    const assets = buildPythonRuntimeAssets(assetPaths, sideModules);
    const workerCode = buildPythonSocketProcessWorker(assets.preamble, sideModules);
    // Side modules are small and were sha256-verified as they were read, so
    // they ride by value; the interpreter image is the big one and goes by path
    // for whichever host ends up running this process to resolve for itself.
    const modules = {};
    for (const [moduleKey, bytes] of Object.entries(sideModules.wasmModules)) {
        modules[moduleKey] = { wasm: bytes };
    }
    if (!assetPaths.asmWasmVfs)
        throw new Error('installed Pyodide manifest is missing pyodide.asm.wasm');
    const spawned = await facetMgr.spawnWorker(workerCode, command, args.cwd, {
        compatibilityFlags: ['nodejs_compat'],
        modules,
        vfsWasmModules: { 'pyodide.asm.wasm': assetPaths.asmWasmVfs },
        startArgs: {
            userCode: args.userCode,
            pyArgv: args.pyArgv,
            userEnv: args.userEnv,
            progName: args.progName,
            cwd: args.cwd,
            fsSnapshot: args.fsSnapshot,
        },
    }).catch(() => null);
    if (!spawned) {
        return { exitCode: 1, stdout: '', stderr: 'python process boot failed\n' };
    }
    const bootParsed = PythonSocketProcessBootResponseSchema.safeParse(spawned.boot);
    if (!bootParsed.success) {
        facetMgr.finishProcess(spawned.pid, 1, 'python process boot failed');
        return {
            exitCode: 1,
            stdout: '',
            stderr: 'python process boot failed\n',
        };
    }
    const boot = bootParsed.data;
    if (boot.state === 'listening' && typeof boot.port === 'number' && boot.port > 0) {
        facetMgr.registerPort(spawned.pid, Number(boot.port));
        const routeablePorts = await facetMgr.waitForRouteablePorts(spawned.pid);
        const routeablePort = routeablePorts.includes(Number(boot.port)) ? Number(boot.port) : routeablePorts[0];
        if (!routeablePort) {
            facetMgr.kill(spawned.pid);
            return {
                exitCode: 1,
                stdout: boot.stdout || '',
                stderr: `${boot.stderr || ''}python: virtual socket port ${boot.port} failed to attach a route handler\n`,
            };
        }
        return {
            exitCode: 0,
            stdout: `${boot.stdout || ''}\x1b[2m[started (long-running): pid=${spawned.pid} cmd="${command}" port=${routeablePort}]\x1b[0m\n`,
            stderr: boot.stderr || '',
            spawnedPid: spawned.pid,
            port: routeablePort,
        };
    }
    const reservedPorts = await facetMgr.waitForRouteablePorts(spawned.pid);
    if (reservedPorts.length > 0) {
        return {
            exitCode: 0,
            stdout: `${boot.stdout || ''}\x1b[2m[started (long-running): pid=${spawned.pid} cmd="${command}" port=${reservedPorts[0]}]\x1b[0m\n`,
            stderr: boot.stderr || '',
            spawnedPid: spawned.pid,
            port: reservedPorts[0],
        };
    }
    if (boot.state === 'exited') {
        const result = boot.result || {};
        facetMgr.finishProcess(spawned.pid, Number(result.exitCode || 0), result.stderr || 'python process exited');
        return {
            exitCode: Number(result.exitCode || 0),
            stdout: result.stdout || '',
            stderr: result.stderr || result.error || '',
            fsDiff: result.fsDiff,
        };
    }
    return {
        exitCode: 0,
        stdout: `${boot.stdout || ''}\x1b[2m[started (long-running): pid=${spawned.pid} cmd="${command}"]\x1b[0m\n`,
        stderr: boot.stderr || '',
        spawnedPid: spawned.pid,
    };
}
function buildPythonSocketProcessWorker(preamble, sideModules) {
    const sideModuleImports = [];
    for (const mod of sideModules.modules) {
        const id = wasmImportIdentifier(mod.moduleKey);
        sideModuleImports.push(`import __NIMBUS_WASM_${id} from './${mod.moduleKey}';`);
        sideModuleImports.push(`globalThis.__NIMBUS_WASM[${JSON.stringify(mod.moduleKey)}] = __NIMBUS_WASM_${id};`);
    }
    return [
        'import { WorkerEntrypoint } from "cloudflare:workers";',
        "import __NIMBUS_WASM_pyodide_asm_wasm from './pyodide.asm.wasm';",
        'globalThis.__NIMBUS_WASM = globalThis.__NIMBUS_WASM || {};',
        "globalThis.__NIMBUS_WASM['pyodide.asm.wasm'] = __NIMBUS_WASM_pyodide_asm_wasm;",
        ...sideModuleImports,
        '',
        VIRTUAL_SOCKET_KERNEL_SRC,
        '',
        'globalThis.__nimbusVirtualPortRegistrationPromises = globalThis.__nimbusVirtualPortRegistrationPromises || [];',
        'globalThis.__nimbusVirtualSocketDidListen = function __nimbusVirtualSocketDidListen(port) {',
        '  const supervisor = globalThis.__nimbusPythonSupervisor;',
        '  if (!supervisor || typeof supervisor.registerPort !== "function") return;',
        '  try {',
        '    const p = supervisor.registerPort(Number(port)).catch((e) => {',
        '      const msg = e && e.message ? e.message : String(e);',
        '      (globalThis.__nimbusPyStderr || (globalThis.__nimbusPyStderr = [])).push("[python-runner] port registration failed: " + msg + "\\n");',
        '    });',
        '    globalThis.__nimbusVirtualPortRegistrationPromises.push(p);',
        '  } catch (e) {',
        '    const msg = e && e.message ? e.message : String(e);',
        '    (globalThis.__nimbusPyStderr || (globalThis.__nimbusPyStderr = [])).push("[python-runner] port registration failed: " + msg + "\\n");',
        '  }',
        '};',
        '',
        preamble,
        '',
        'globalThis.__nimbusPythonSocketserverQueue = globalThis.__nimbusPythonSocketserverQueue || Promise.resolve();',
        'function __nimbusRunPythonSocketserverCall(fnName, port) {',
        '  const run = async () => {',
        '    const pyodide = globalThis.__nimbusPyodideInstance;',
        '    if (!pyodide || typeof pyodide.runPythonAsync !== "function") return false;',
        '    const n = Number(port);',
        '    if (!Number.isInteger(n) || n <= 0 || n >= 65536) return false;',
        '    try {',
        '      await pyodide.runPythonAsync(fnName + "(" + n + ")");',
        '      return true;',
        '    } catch (e) {',
        '      const msg = e && e.message ? e.message : String(e);',
        '      (globalThis.__nimbusPyStderr || (globalThis.__nimbusPyStderr = [])).push("[python-runner] socketserver call failed: " + msg + "\\n");',
        '      return false;',
        '    }',
        '  };',
        '  const task = globalThis.__nimbusPythonSocketserverQueue.then(run, run);',
        '  globalThis.__nimbusPythonSocketserverQueue = task.then(() => {}, () => {});',
        '  return task;',
        '}',
        'globalThis.__nimbusVirtualSocketEnsureListener = function __nimbusVirtualSocketEnsureListener(port) {',
        '  return __nimbusRunPythonSocketserverCall("_nimbus_ensure_socketserver_listener", port);',
        '};',
        'globalThis.__nimbusVirtualSocketRequestQueued = function __nimbusVirtualSocketRequestQueued(port) {',
        '  return __nimbusRunPythonSocketserverCall("_nimbus_handle_socketserver_request", port);',
        '};',
        '',
        'async function __nimbusStartPythonProcess(args) {',
        '  if (!globalThis.__nimbusPythonProcessPromise) {',
        '    const stdoutStart = (globalThis.__nimbusPyStdout || []).length;',
        '    const stderrStart = (globalThis.__nimbusPyStderr || []).length;',
        '    globalThis.__nimbusPythonProcessOutputStart = { stdoutStart, stderrStart };',
        '    globalThis.__nimbusPythonProcessPromise = (async () => {',
        '      const result = await globalThis.__pyodideRun({',
        '        userCode: args.userCode,',
        '        pyArgv: args.pyArgv || [],',
        '        userEnv: args.userEnv || {},',
        '        progName: args.progName || "python",',
        '        cwd: args.cwd || "/home/user",',
        '        fsSnapshot: args.fsSnapshot,',
        '        asyncRun: true,',
        '      });',
        '      globalThis.__nimbusPythonProcessResult = result;',
        '      return result;',
        '    })();',
        '  }',
        '  const started = globalThis.__nimbusPythonProcessOutputStart || { stdoutStart: 0, stderrStart: 0 };',
        '  const listen = globalThis.__nimbusVirtualSockets.waitForListen(10_000).then((port) => ({ state: port ? "listening" : "pending", port }));',
        '  const exit = globalThis.__nimbusPythonProcessPromise.then((result) => ({ state: "exited", result }));',
        '  const first = await Promise.race([listen, exit]);',
        '  const registrations = globalThis.__nimbusVirtualPortRegistrationPromises || [];',
        '  if (registrations.length > 0) await Promise.allSettled(registrations.splice(0));',
        '  const stdout = (globalThis.__nimbusPyStdout || []).slice(started.stdoutStart).join("");',
        '  const stderr = (globalThis.__nimbusPyStderr || []).slice(started.stderrStart).join("");',
        '  if (first.state === "listening") return { state: "listening", port: first.port, stdout, stderr };',
        '  if (first.state === "exited") return { state: "exited", result: first.result, stdout, stderr };',
        '  const currentPort = globalThis.__nimbusVirtualSockets.firstListeningPort();',
        '  if (currentPort) return { state: "listening", port: currentPort, stdout, stderr };',
        '  return { state: "running", stdout, stderr };',
        '}',
        '',
        'export default class NimbusPythonProcess extends WorkerEntrypoint {',
        '  async startProcess(args) {',
        '    globalThis.__nimbusPythonSupervisor = this.env?.SUPERVISOR;',
        '    return __nimbusStartPythonProcess(args || {});',
        '  }',
        '  async fetch(request) {',
        '    globalThis.__nimbusPythonSupervisor = this.env?.SUPERVISOR;',
        '    return this.handleHttpRequest(request);',
        '  }',
        '  async handleHttpRequest(request) {',
        '    const hinted = Number(request.headers.get("X-Nimbus-Port") || 0);',
        '    const port = hinted || Array.from(globalThis.__nimbusVirtualSockets.listeners.keys())[0];',
        '    if (!port) return new Response("Nimbus Python process has no listening virtual socket", { status: 502 });',
        '    return globalThis.__nimbusVirtualSockets.handleHttpRequest(port, request);',
        '  }',
        '}',
    ].join('\n');
}
async function createPythonFacetRuntime(facetMgr, args, sideModules) {
    const toAB = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const assets = buildPythonRuntimeAssets(args, sideModules);
    const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
    const env = facetMgr.env;
    const ctx = facetMgr.ctx;
    const pool = new NimbusLoaderPool(env, ctx, {
        tag: 'python-runner',
        concurrency: 1,
        omitSupervisor: true,
        preamble: assets.preamble,
        wasmModules: {
            'pyodide.asm.wasm': toAB(assets.asmWasmBytes),
            ...sideModules.wasmModules,
        },
    });
    return { pool };
}
/**
 * Compose the per-call preamble by splicing the workerd-adapted
 * pyodide.asm.js source ahead of the __pyodideRun helper. Workerd compiles this
 * blob as JS at module-load time (where `var` declarations + globals
 * assignment are allowed), then the asm.js's `var _createPyodideModule`
 * is hoisted onto globalThis.
 */
// REPL-W1: exported so the adjacent src/runtime/python-repl.ts can
// reuse the canonical preamble verbatim. Additive change only —
// internal callers are unchanged. The `export` keyword is the sole
// modification to python-runner.ts in the REPL-W1 wave.
export function buildPyodidePreamble(asmJsSrc, stdlibB64, lockfileContents = '{"packages":{}}', sideModules = []) {
    return [
        '// ── Pre-asm.js environment shims ───────────────────────────────',
        '// Pyodide captures environment flags in its outer asm.js IIFE. Hide',
        '// workerd\'s Node globals before inlining it, then restore them after',
        '// the factory has captured the browser-compatible environment.',
        'const __nimbusOrigProcess = globalThis.process;',
        'const __nimbusOrigWGS = globalThis.WorkerGlobalScope;',
        'try { globalThis.process = undefined; } catch (e) { /* non-writable; fall through */ }',
        '// Handle runtimes where process is non-writable.',
        'try {',
        '  if (globalThis.process && typeof globalThis.process === "object") globalThis.process.browser = true;',
        '} catch (e) { /* fail-soft */ }',
        'globalThis.WorkerGlobalScope = Object;',
        'if (typeof globalThis.location !== "object" || globalThis.location === null) {',
        '  globalThis.location = { href: "pyodide://nimbus/", origin: "pyodide://nimbus", toString() { return this.href; } };',
        '}',
        'if (typeof globalThis.document === "undefined") globalThis.document = undefined;',
        'if (typeof globalThis.self === "undefined") globalThis.self = globalThis;',
        '',
        '// Pyodide requires FinalizationRegistry during initialization.',
        'if (typeof globalThis.FinalizationRegistry === "undefined") {',
        '  globalThis.FinalizationRegistry = class FinalizationRegistry {',
        '    constructor(_cleanup) {}',
        '    register(_target, _heldValue, _token) {}',
        '    unregister(_token) {}',
        '  };',
        '}',
        '',
        '// ── BEGIN: pyodide.asm.js (inlined; ~1 MiB) ─────────────────────',
        '// Module-load time evaluation. Declares `var _createPyodideModule`',
        '// at module scope; the next line hoists it onto globalThis so the',
        '// __pyodideRun helper below can reach it across slot reuses.',
        asmJsSrc,
        'if (typeof _createPyodideModule === \'function\') {',
        '  globalThis._createPyodideModule = _createPyodideModule;',
        '}',
        '// Restore originals after the asm.js IIFE outer captures env flags.',
        '// (The bootstrap promise below re-hides them inside its own async',
        '// scope so the env-detection inside the async factory body sees the',
        '// stubbed values.)',
        'try { globalThis.process = __nimbusOrigProcess; } catch (e) { /* fall through */ }',
        'try { if (globalThis.process && globalThis.process.browser === true) delete globalThis.process.browser; } catch (e) {}',
        'globalThis.WorkerGlobalScope = __nimbusOrigWGS;',
        '// ── END: pyodide.asm.js inline ──────────────────────────────────',
        '',
        buildPreambleTail(stdlibB64, lockfileContents, sideModules),
    ].join('\n');
}
// ── Facet preamble ───────────────────────────────────────────────────
//
// The preamble runs at facet module-init (workerd compiles it once
// per slot). It exposes __pyodideRun(args) on globalThis which the
// dispatched facet fn calls.
//
// Strategy mirrors Cloudflare's `python-entrypoint-helper.ts`:
//   1. Decode pyodide.asm.js bytes from context → JS source string.
//   2. new Function(asmJsSrc + '; return _createPyodideModule')()
//      — runs the Emscripten loader, returns the factory. workerd
//      allows new Function at module-init time.
//   3. Build the Emscripten settings object directly (skip the
//      public loadPyodide wrapper — we don't need its file-system
//      probing, lockfile loader, indexURL juggling). Override:
//        - instantiateWasm: feed precompiled module from __NIMBUS_WASM
//        - preRun: write python_stdlib.zip into MEMFS at /lib/python313.zip
//        - print / printErr: capture to stdout/stderr buffers
//        - onExit: capture exit code
//        - stdin: feed user input if any
//        - arguments_: sys.argv
//        - thisProgram: progName (becomes sys.argv[0])
//        - ENV: user env vars
//   4. Call _createPyodideModule(settings) → Pyodide instance
//   5. Run user code via Pyodide.runPython
//   6. Return captured stdout/stderr/exitCode
// pyodide.asm.js is inlined ABOVE this preamble by
// buildPyodidePreamble(asmJsSrc). It declares 'var
// _createPyodideModule = (() => { ... })()' at module-top and we
// hoist it onto globalThis right after the inline. By the time
// __pyodideRun is invoked at request time, globalThis._createPyodideModule
// is already populated; we never invoke `new Function` (CSP-blocked
// at request time).
// ── Preamble tail builder ─────────────────────────────────────────────
//
// Generates the preamble tail with stdlibB64 spliced as a constant so
// the bootstrap can run at child-facet module-init time (not request
// time). Module-init time is where workerd permits
// `new WebAssembly.Module(rawBytes)`, which Pyodide's
// convertJsFunctionToWasm uses to build JS-callback-to-wasm shims.
// Without module-init context, that throws CompileError and the
// bootstrap promise never resolves → workerd cancels the request as
// hung. (This v2 redesign was directly motivated by the
// /tmp/pyodide-smoketest finding — see
//
// Architecture:
//
//   PREAMBLE (runs at child-facet module-init):
//   ┌─────────────────────────────────────────────────────────────┐
//   │ - env shims (FinalizationRegistry, process, WGS, location)  │
//   │ - asm.js eval (defines _createPyodideModule)                │
//   │ - stdlibB64 constant + decoded stdlibBytes                  │
//   │ - sentinel wasm module compiled                             │
//   │ - globalThis.__pyodideBootstrap = (async () => { ... })()   │
//   │     ├─ preRun: installStdlib, setHome, setEnv,              │
//   │     │           initializeNativeFS, gateRuntimeInit         │
//   │     ├─ _createPyodideModule(settings) called                │
//   │     ├─ Awaits at gate (until request time)                  │
//   │     └─ Resolves with pyodideMod after gate release          │
//   └─────────────────────────────────────────────────────────────┘
//
//   __pyodideRun(args) (runs at child-facet request handler):
//   ┌─────────────────────────────────────────────────────────────┐
//   │ - Release the bootstrap gate (crypto.getRandomValues OK now)│
//   │ - Await __pyodideBootstrap → pyodideMod                     │
//   │ - finalizeBootstrap → pyodide                               │
//   │ - runPython(userCode) → stdout/stderr/exitCode              │
//   └─────────────────────────────────────────────────────────────┘
//
function buildPreambleTail(stdlibB64, lockfileContents, sideModules) {
    return `
// ── BEGIN: python-runner preamble tail (Pyodide 0.29.4, Nimbus v2) ──

// Stdlib bytes spliced into preamble at facet-build time. ~3.2 MiB
// base64 text — decoded once at module-init. Same content as
// share/pyodide/python_stdlib.zip in the runtime cache.
const __NIMBUS_STDLIB_B64 = ${JSON.stringify(stdlibB64)};
const __NIMBUS_LOCKFILE_CONTENTS = ${JSON.stringify(lockfileContents)};
const __NIMBUS_PERSISTENT_SITE_PACKAGES = '/home/user/.nimbus-python/site-packages';
const __NIMBUS_PYTHON_SOCKET_SHIM = ${JSON.stringify(PYTHON_SOCKET_SHIM)};
const __NIMBUS_PYODIDE_SIDE_MODULES = ${JSON.stringify(sideModules)};

// Must precede the .toString() embeds below, whose bodies call __name(...).
${ESBUILD_NAME_GLOBAL_SHIM}

${expandPythonEffectiveMode.toString()}
${installPythonFsSnapshot.toString()}

// Decode base64 → Uint8Array. Run at module-init time (synchronous).
const __nimbusStdlibBytes = (function decode(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
})(__NIMBUS_STDLIB_B64);

// Sentinel-module setup. Pyodide's pyodide.mjs compiles a tiny standalone
// wasm blob that exports {create_sentinel, is_sentinel} and attaches its
// exports as imports.sentinel BEFORE instantiating pyodide.asm.wasm. We
// bypass loadPyodide → must replicate here. The base64 blob below is
// verbatim from pyodide.mjs (variable \`G\` in v0.29.4).
const __NIMBUS_SENTINEL_WASM_B64 = 'AGFzbQEAAAABDANfAGAAAW9gAW8BfwMDAgECByECD2NyZWF0ZV9zZW50aW5lbAAAC2lzX3NlbnRpbmVsAAEKEwIHAPsBAPsbCwkAIAD7GvsUAAs=';
let __nimbusSentinelExports;
try {
  const bin = atob(__NIMBUS_SENTINEL_WASM_B64);
  const sentinelBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) sentinelBytes[i] = bin.charCodeAt(i);
  // Synchronous wasm compile at module-init (CSP permits here).
  const sentinelMod = new WebAssembly.Module(sentinelBytes);
  const sentinelInst = new WebAssembly.Instance(sentinelMod);
  __nimbusSentinelExports = sentinelInst.exports;
} catch (_e) {
  // CSP fallback — pyodide.mjs's K() also has this Symbol-based path.
  const marker = Symbol('sentinel');
  __nimbusSentinelExports = {
    create_sentinel: function() { return marker; },
    is_sentinel: function(v) { return v === marker; },
  };
}

// Module-init stdout/stderr capture buffers. Used by Pyodide's print/
// printErr (set in settings below). The per-call __pyodideRun grabs a
// slice from these buffers to isolate output per invocation.
globalThis.__nimbusPyStdout = globalThis.__nimbusPyStdout || [];
globalThis.__nimbusPyStderr = globalThis.__nimbusPyStderr || [];

if (!globalThis.__nimbusPythonFetchStripsIntegrity && typeof globalThis.fetch === 'function') {
  const __nimbusOrigFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = function nimbusPythonFetch(input, init) {
    if (init && typeof init === 'object' && init.integrity) {
      const clean = Object.assign({}, init);
      delete clean.integrity;
      return __nimbusOrigFetch(input, clean);
    }
    return __nimbusOrigFetch(input, init);
  };
  globalThis.__nimbusPythonFetchStripsIntegrity = true;
}

function __nimbusBytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function __nimbusInstallPythonSocketModules(pyodide) {
  if (!globalThis.__nimbusVirtualSockets || !pyodide || globalThis.__nimbusPythonSocketsInstalled) return;
  const kernel = globalThis.__nimbusVirtualSockets;
  try {
    pyodide.registerJsModule('nimbus_sockets', {
      listen: (port) => kernel.listen(port),
      close_listener: (port) => kernel.closeListener(port),
      accept: async (port) => await kernel.accept(port),
      accept_now: (port) => kernel.acceptNow(port),
      recv: (id, maxBytes) => kernel.recv(id, maxBytes),
      send: (id, bytes) => kernel.send(id, bytes),
      close: (id) => kernel.close(id),
      pending: (port) => kernel.pending(port),
      sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))),
      wait_readable: async (ports, timeoutSeconds) => await kernel.waitReadable(Array.from(ports || []), timeoutSeconds),
    });
  } catch {}
  try {
    pyodide.runPython(__NIMBUS_PYTHON_SOCKET_SHIM);
    globalThis.__nimbusPythonSocketsInstalled = true;
  } catch (e) {
    globalThis.__nimbusPyStderr.push('[python-runner] virtual socket shim install failed: ' + (e && e.message) + '\\n');
  }
}

function __nimbusNormalizePyodideSideModulePath(path) {
  const clean = String(path || '').replace(/\\\\/g, '/').replace(/^\\/+/, '');
  const marker = '/site-packages/';
  const markerIndex = clean.indexOf(marker);
  return markerIndex >= 0 ? clean.slice(markerIndex + marker.length) : clean;
}

globalThis.__nimbusResolvePyodideSideModule = function __nimbusResolvePyodideSideModule(binary, libName) {
  if (binary instanceof WebAssembly.Module) return binary;
  const requested = __nimbusNormalizePyodideSideModulePath(libName);
  const match = __NIMBUS_PYODIDE_SIDE_MODULES.find(function(entry) {
    return requested === entry.sitePath || requested.endsWith('/' + entry.sitePath);
  });
  if (!match) {
    if (String(libName || '').endsWith('.so')) {
      throw new Error('Nimbus Pyodide startup module is not registered for ' + String(libName || '(unnamed extension)'));
    }
    return binary;
  }
  const wasmTable = globalThis.__NIMBUS_WASM || {};
  const module = wasmTable[match.moduleKey];
  if (!(module instanceof WebAssembly.Module)) {
    throw new Error('Nimbus Pyodide startup module missing for ' + match.sitePath + ' (' + match.moduleKey + ')');
  }
  return module;
};

function __nimbusDisableDynamicPythonExtensions(pyodide) {
  if (!pyodide || globalThis.__nimbusPythonExtensionsDisabled) return;
  try {
    pyodide.runPython(
      'import importlib.machinery as _nimbus_importlib_machinery, sys as _nimbus_sys\\n' +
      'try:\\n' +
      '    _nimbus_importlib_machinery.EXTENSION_SUFFIXES[:] = []\\n' +
      'except Exception:\\n' +
      '    try:\\n' +
      '        _nimbus_importlib_machinery.EXTENSION_SUFFIXES = []\\n' +
      '    except Exception:\\n' +
      '        pass\\n' +
      'try:\\n' +
      '    _nimbus_sys.path_importer_cache.clear()\\n' +
      'except Exception:\\n' +
      '    pass\\n'
    );
    globalThis.__nimbusPythonExtensionsDisabled = true;
  } catch (e) {
    globalThis.__nimbusPyStderr.push('[python-runner] extension import policy failed: ' + (e && e.message) + '\\n');
  }
}

function __nimbusNormPath(path) {
  const clean = String(path || '').replace(/^\\/+/, '').replace(/\\/+$/, '');
  return clean ? '/' + clean : '/';
}

function __nimbusWalkPyFs(M, absDir, out) {
  let entries;
  try { entries = M.FS.readdir(absDir); } catch { return; }
  for (const name of entries) {
    if (name === '.' || name === '..') continue;
    if (name === '.nimbus' || name === 'node_modules' || name === '.cache' || name === '.npm') continue;
    const abs = absDir === '/' ? '/' + name : absDir + '/' + name;
    const rel = abs.replace(/^\\/+/, '');
    let stat;
    try { stat = M.FS.stat(abs); } catch { continue; }
    if (M.FS.isDir(stat.mode)) {
      out.dirs.push(rel);
      __nimbusWalkPyFs(M, abs, out);
      continue;
    }
    if (M.FS.isFile(stat.mode)) {
      try { out.files[rel] = __nimbusBytesToB64(M.FS.readFile(abs)); } catch {}
    }
  }
}

function __nimbusSnapshotPyDiff(M, before) {
  if (!before || !before.root) return null;
  const roots = Array.from(new Set(((before.roots && before.roots.length) ? before.roots : [before.root]).filter(Boolean)));
  const after = { dirs: roots.slice(), files: {} };
  for (const root of roots) {
    __nimbusWalkPyFs(M, __nimbusNormPath(root), after);
  }
  const beforeDirs = new Set(before.dirs || []);
  const afterDirs = new Set(after.dirs || []);
  const dirsCreated = after.dirs.filter((path) => !beforeDirs.has(path));
  const dirsDeleted = (before.dirs || []).filter((path) => !afterDirs.has(path)).sort((a, b) => b.length - a.length);
  const filesWritten = {};
  const filesDeleted = [];
  const beforeFiles = before.files || {};
  for (const [path, b64] of Object.entries(after.files)) {
    if (beforeFiles[path] !== b64) filesWritten[path] = b64;
  }
  for (const path of Object.keys(beforeFiles)) {
    if (!(path in after.files)) filesDeleted.push(path);
  }
  return { filesWritten, filesDeleted, dirsCreated, dirsDeleted };
}

// Bootstrap gate release fn — populated by gateRuntimeInit preRun hook
// during _createPyodideModule's synchronous preRun pass.
globalThis.__nimbusReleaseGate = null;

// ── Bootstrap promise (kicked off at child-facet module-init) ────────
//
// CRITICAL: this promise is created at module-init time so the
// _createPyodideModule call (and its synchronous wasm-module-compile
// side effects, including convertJsFunctionToWasm) happens in
// startup-CSP context. The promise body's awaits run as microtasks
// after module-init returns, but the SYNCHRONOUS portion of
// _createPyodideModule (wasm instantiate + preRun + reportUndefinedSymbols
// + convertJsFunctionToWasm) all completes before the first await.
//
// We hide process + WGS inside this async function so the env-detection
// inside Pyodide's async factory body sees the stubbed values, then
// restore them in the finally block.
globalThis.__pyodideBootstrap = (async function nimbusBootstrap() {
  if (typeof globalThis._createPyodideModule !== 'function') {
    return { ok: false, error: '_createPyodideModule not installed by inline asm.js' };
  }
  const __origProcess = globalThis.process;
  const __origWGS = globalThis.WorkerGlobalScope;
  try { globalThis.process = undefined; } catch {}
  try {
    if (globalThis.process && typeof globalThis.process === 'object') {
      globalThis.process.browser = true;
    }
  } catch {}
  try { globalThis.WorkerGlobalScope = Object; } catch {}

  try {
    // Get the wasm module that the loader-pool injected via __NIMBUS_WASM.
    const wasmTable = globalThis.__NIMBUS_WASM || {};
    const asmWasmMod = wasmTable['pyodide.asm.wasm'];
    if (!asmWasmMod) {
      return { ok: false, error: '__NIMBUS_WASM missing pyodide.asm.wasm' };
    }

    const pyodidePackageBaseUrl = 'https://cdn.jsdelivr.net/pyodide/v0.29.4/full/';

    // Initial Pyodide config — note: args, env, progName come from the
    // per-call args at request time. We use sensible defaults here so
    // the bootstrap can complete; per-call __pyodideRun overrides via
    // M.ENV / pyodide.runPython arguments.
    const config = {
      indexURL: '/pyodide/',
      cdnUrl: pyodidePackageBaseUrl,
      packageBaseUrl: pyodidePackageBaseUrl,
      fullStdLib: false,
      jsglobals: globalThis,
      args: [],
      env: { HOME: '/home/pyodide', PYTHONINSPECT: '1' },
      packages: [],
      lockFileContents: __NIMBUS_LOCKFILE_CONTENTS,
      packageCacheDir: pyodidePackageBaseUrl,
      enableRunUntilComplete: true,
      checkAPIVersion: false,
      _sysExecutable: 'python',
      BUILD_ID: 'nimbus-pyodide-0.29.4',
    };

    const settings = {
      noInitialRun: false,
      noExitRuntime: true,
      noImageDecoding: true,
      noAudioDecoding: true,
      noWasmDecoding: false,
      print: function(s) { globalThis.__nimbusPyStdout.push(s + '\\n'); },
      printErr: function(s) { globalThis.__nimbusPyStderr.push(s + '\\n'); },
      // onExit captures the SystemExit code from Pyodide via Emscripten's
      // ExitStatus path. The per-call __pyodideRun resets __nimbusExitCode
      // to undefined before runPython and reads it after.
      onExit: function(code) { globalThis.__nimbusExitCode = code | 0; },
      thisProgram: config._sysExecutable,
      arguments: config.args,
      API: {
        config: config,
        runtimeEnv: { IN_NODE: false, IN_BROWSER: false, IN_SHELL: false },
        lockFilePromise: Promise.resolve(__NIMBUS_LOCKFILE_CONTENTS),
      },
      locateFile: function(path) { return '/pyodide/' + path; },
      instantiateWasm: function(imports, successCallback) {
        // Attach sentinel namespace synchronously — Pyodide expects
        // imports.sentinel = {create_sentinel, is_sentinel}.
        imports.sentinel = __nimbusSentinelExports;
        WebAssembly.instantiate(asmWasmMod, imports).then(function(result) {
          const inst = (result instanceof WebAssembly.Instance ? result : result.instance);
          try {
            successCallback(inst, asmWasmMod);
          } catch (cbErr) {
            globalThis.__nimbusPyStderr.push('[python-runner] receiveInstance threw: ' + (cbErr && cbErr.message) + '\\n');
            throw cbErr;
          }
        }).catch(function(e) {
          globalThis.__nimbusPyStderr.push('[python-runner] wasm instantiate failed: ' + (e && e.message) + '\\n');
        });
        return {};
      },
    };

    // Faithful replication of pyodide.mjs's
    // getFileSystemInitializationFuncs ordering, plus our request-gate.
    settings.preRun = [
      function installStdlib(M) {
        M.addRunDependency('nimbus-install-stdlib');
        try {
          const verWord = M.HEAPU32[M._Py_Version >>> 2];
          const major = (verWord >>> 24) & 0xff;
          const minor = (verWord >>> 16) & 0xff;
          M.API.pyVersionTuple = [major, minor, (verWord >>> 8) & 0xff];
          M.FS.mkdirTree('/lib');
          M.API.sitePackages = '/lib/python' + major + '.' + minor + '/site-packages';
          M.FS.mkdirTree(M.API.sitePackages);
          M.FS.writeFile('/lib/python' + major + minor + '.zip', __nimbusStdlibBytes);
        } catch (e) {
          globalThis.__nimbusPyStderr.push('[python-runner] installStdlib failed: ' + (e && e.message) + '\\n');
        } finally {
          M.removeRunDependency('nimbus-install-stdlib');
        }
      },
      function setHome(M) {
        let home = config.env.HOME;
        try { M.FS.mkdirTree(home); } catch { home = '/'; }
        try { M.FS.chdir(home); } catch {}
      },
      function setEnv(M) {
        try { Object.assign(M.ENV, config.env); } catch {}
      },
      function initializeNativeFS(M) {
        try {
          M.FS.filesystems.NATIVEFS_ASYNC = {
            mount: function() { throw new Error('NATIVEFS_ASYNC not implemented'); },
            syncfs: function(_m, _p, cb) { cb(); },
          };
        } catch {}
      },
      function gateRuntimeInit(M) {
        // Adds a runDependency that defers Pyodide's doRun (callMain →
        // CPython __wasm_call_ctors → crypto.getRandomValues — blocked
        // at module-init) until our request handler releases it.
        M.addRunDependency('nimbus-request-gate');
        globalThis.__nimbusReleaseGate = function() {
          try { M.removeRunDependency('nimbus-request-gate'); } catch {}
        };
      },
    ];

    // Stash settings on globalThis so __pyodideRun can mutate config
    // (args/env/progName) at request time before runPython.
    globalThis.__nimbusPyConfig = config;

    // Kick off _createPyodideModule. Its synchronous portion runs all
    // preRun hooks (registering the gate) and instantiates the wasm
    // module (including convertJsFunctionToWasm in
    // reportUndefinedSymbols — the v1 hang root). The returned promise
    // resolves when the gate is released at request time.
    const modPromise = globalThis._createPyodideModule(settings);
    const pyodideMod = await modPromise;
    return { ok: true, mod: pyodideMod };
  } catch (e) {
    return { ok: false, error: '_createPyodideModule failed: ' + (e && e.message), stack: e && e.stack };
  } finally {
    try { globalThis.process = __origProcess; } catch {}
    try {
      if (globalThis.process && globalThis.process.browser === true) {
        delete globalThis.process.browser;
      }
    } catch {}
    globalThis.WorkerGlobalScope = __origWGS;
  }
})();

// ── Per-call entry point ─────────────────────────────────────────────
//
// Invoked from the LOADER child facet's execute() (which calls the
// serialized facetFn that does globalThis.__pyodideRun(args)).
//
// At this point the bootstrap promise is mid-flight at the gate.
// We release the gate, await the bootstrap completion (which now
// runs CPython init in request-handler CSP context where
// crypto.getRandomValues is permitted), then finalizeBootstrap +
// runPython.
globalThis.__pyodideRun = async function __pyodideRun(args) {
  // Tracks where in the user's request output begins (the bootstrap
  // may have produced some print() output too, but in practice it
  // doesn't — CPython's Py_Initialize is silent).
  const stdoutStart = globalThis.__nimbusPyStdout.length;
  const stderrStart = globalThis.__nimbusPyStderr.length;

  // Override config args/env/progName for THIS call. The bootstrap
  // used defaults; the user's actual sys.argv and env are applied here.
  // setEnv preRun ran with the old config — we re-apply onto M.ENV
  // via runPython below.
  if (globalThis.__nimbusPyConfig) {
    globalThis.__nimbusPyConfig.args = args.pyArgv.slice(1);
    globalThis.__nimbusPyConfig.env = Object.assign({}, globalThis.__nimbusPyConfig.env, args.userEnv || {});
    globalThis.__nimbusPyConfig._sysExecutable = args.progName;
  }

  // Release the bootstrap gate (registered by gateRuntimeInit preRun).
  // Required: workerd blocks crypto.getRandomValues at module-init.
  // Releasing at request time lets Pyodide's doRun → callMain →
  // __wasm_call_ctors → randomFill run in request-handler context.
  if (typeof globalThis.__nimbusReleaseGate === 'function') {
    globalThis.__nimbusReleaseGate();
    // Make idempotent so a re-entrant call doesn't double-release.
    globalThis.__nimbusReleaseGate = function() {};
  }

  // Await bootstrap completion.
  const boot = await globalThis.__pyodideBootstrap;
  if (!boot.ok || !boot.mod) {
    return {
      exitCode: 1,
      stdout: globalThis.__nimbusPyStdout.slice(stdoutStart).join(''),
      stderr: globalThis.__nimbusPyStderr.slice(stderrStart).join(''),
      error: 'pyodide bootstrap failed: ' + (boot.error || 'unknown'),
    };
  }
  const pyodideMod = boot.mod;
  const previousIgnorePermissions = pyodideMod.FS.ignorePermissions;

  try {
    // Pyodide owns the bootstrap filesystem. Keep setup unrestricted, then
    // enforce the invoking credential's expanded snapshot modes for Python.
    pyodideMod.FS.ignorePermissions = true;

    // Apply user env to MEMFS now that CPython is up. (The preRun setEnv
    // ran with bootstrap defaults; we layer the user env on top.)
    if (args.userEnv) {
      try { Object.assign(pyodideMod.ENV, args.userEnv); } catch {}
    }
    try {
      globalThis.__nimbusMountedPyFiles = installPythonFsSnapshot(
        pyodideMod.FS,
        args.fsSnapshot,
        globalThis.__nimbusMountedPyFiles || new Set(),
      );
    } catch (e) {
      return {
        exitCode: 1,
        stdout: globalThis.__nimbusPyStdout.slice(stdoutStart).join(''),
        stderr: globalThis.__nimbusPyStderr.slice(stderrStart).join(''),
        error: 'VFS mount failed: ' + (e && e.message),
      };
    }
    try {
      pyodideMod.FS.mkdirTree(__NIMBUS_PERSISTENT_SITE_PACKAGES);
      pyodideMod.API.sitePackages = __NIMBUS_PERSISTENT_SITE_PACKAGES;
    } catch {}
    const cwd = __nimbusNormPath(args.cwd || (args.userEnv && args.userEnv.HOME) || '/home/user');
    try { pyodideMod.FS.mkdirTree(cwd); } catch {}

  // finalizeBootstrap returns the public Pyodide JS API (the one with
  // .runPython, .globals, .registerJsModule). It registers Python-side
  // js-module hooks via register_js_finder; calling it twice on the
  // same pyodideMod throws "JsFinder already registered". So we cache
  // the result globally and reuse it across multiple __pyodideRun
  // invocations (which happen when the child-facet pool reuses the
  // same Pyodide instance for multiple python -c calls in one session).
  let pyodide = globalThis.__nimbusPyodideInstance;
  if (!pyodide) {
    try {
      pyodide = pyodideMod.API.finalizeBootstrap(undefined, undefined);
      globalThis.__nimbusPyodideInstance = pyodide;
    } catch (e) {
      return {
        exitCode: 1,
        stdout: globalThis.__nimbusPyStdout.slice(stdoutStart).join(''),
        stderr: globalThis.__nimbusPyStderr.slice(stderrStart).join(''),
        error: 'finalizeBootstrap failed: ' + (e && e.message),
      };
    }
  }

  // Update sys.argv to reflect this call's progName + pyArgv. Pyodide's
  // thisProgram is fixed at bootstrap time (when callMain ran); we
  // overwrite sys.argv at request time via a tiny runPython prelude.
  // pyArgv is the user-visible argv (script name first, then args);
  // progName is the executable that prefixes errors.
  const effectiveArgv = args.pyArgv;

  let userGlobals = null;
  try {
    const dictCtor = pyodide.globals?.get?.('dict');
    userGlobals = typeof dictCtor === 'function' ? dictCtor() : null;
    if (userGlobals && typeof userGlobals.set === 'function') {
      userGlobals.set('__name__', '__main__');
      userGlobals.set('__package__', null);
      const argv0 = effectiveArgv[0];
      if (argv0 && argv0 !== '-c' && argv0 !== '-') {
        userGlobals.set('__file__', argv0);
      }
    }
    try { dictCtor?.destroy?.(); } catch {}
  } catch {
    userGlobals = null;
  }

  __nimbusInstallPythonSocketModules(pyodide);
  if (!Array.isArray(__NIMBUS_PYODIDE_SIDE_MODULES) || __NIMBUS_PYODIDE_SIDE_MODULES.length === 0) {
    __nimbusDisableDynamicPythonExtensions(pyodide);
  }

  pyodideMod.FS.ignorePermissions = false;

  try {
    pyodide.runPython(
      'import os, sys\\n' +
	      'sys.argv = ' + JSON.stringify(effectiveArgv) + '\\n' +
	      'cwd = ' + JSON.stringify(args.cwd || '/home/user') + '\\n' +
	      'env_updates = ' + JSON.stringify(args.userEnv || {}) + '\\n' +
	      'for _k, _v in env_updates.items():\\n    os.environ[str(_k)] = str(_v)\\n' +
	      'site_packages = ' + JSON.stringify('/home/user/.nimbus-python/site-packages') + '\\n' +
	      'try:\\n    os.chdir(cwd)\\nexcept Exception:\\n    pass\\n' +
	      'try:\\n    os.makedirs(site_packages, exist_ok=True)\\nexcept Exception:\\n    pass\\n' +
	      'if site_packages not in sys.path:\\n    sys.path.insert(0, site_packages)\\n' +
	      'try:\\n    import site as _nimbus_site; _nimbus_site.addsitedir(site_packages)\\nexcept Exception:\\n    pass\\n' +
	      'try:\\n    import sysconfig as _nimbus_sysconfig\\n    for _scheme in getattr(_nimbus_sysconfig, "_INSTALL_SCHEMES", {}).values():\\n        _scheme["purelib"] = site_packages\\n        _scheme["platlib"] = site_packages\\nexcept Exception:\\n    pass\\n' +
	      'if "" not in sys.path:\\n    sys.path.insert(0, "")\\n',
      userGlobals ? { globals: userGlobals } : undefined
    );
  } catch { /* best-effort */ }

  // Reset onExit capture for this call.
  globalThis.__nimbusExitCode = undefined;

  // Run the user code.
  let exitCode = 0;
  if (args.userCode) {
    try {
      if (args.asyncRun && typeof pyodide.runPythonAsync === 'function') {
        await pyodide.runPythonAsync(
          args.userCode,
          userGlobals ? { globals: userGlobals } : undefined
        );
      } else {
        pyodide.runPython(
          args.userCode,
          userGlobals ? { globals: userGlobals } : undefined
        );
      }
      // If runPython returned normally, exit code is 0 unless onExit
      // was invoked (which can happen if user called sys.exit but
      // Pyodide handled it via ExitStatus before throwing).
      if (typeof globalThis.__nimbusExitCode === 'number') {
        exitCode = globalThis.__nimbusExitCode;
      }
    } catch (e) {
      // onExit (Emscripten ExitStatus) does not fire here: noExitRuntime
      // is true and sys.exit raises a Python SystemExit that Pyodide
      // re-raises as a JS PythonError rather than calling _exit. So the
      // exit status must be derived from the raised exception.
      //
      // PythonError.type carries the Python exception class name, and the
      // message is a full traceback whose final line is "<Type>: <value>"
      // (or just "<Type>" when the exception carries no argument).
      if (typeof globalThis.__nimbusExitCode === 'number') {
        exitCode = globalThis.__nimbusExitCode;
      } else if (e && e.type === 'SystemExit') {
        // sys.exit semantics: int code → that code; None / no arg → 0;
        // any other object → 1 with the object printed to stderr.
        const lastLine = typeof e.message === 'string'
          ? e.message.trimEnd().split('\\n').pop()
          : '';
        const sep = lastLine.indexOf(':');
        const rawValue = sep >= 0 ? lastLine.slice(sep + 1).trim() : '';
        if (!rawValue) {
          exitCode = 0;
        } else if (/^-?\\d+$/.test(rawValue)) {
          exitCode = Number(rawValue);
        } else {
          globalThis.__nimbusPyStderr.push(rawValue + '\\n');
          exitCode = 1;
        }
      } else if (e && typeof e.message === 'string') {
        globalThis.__nimbusPyStderr.push(e.message + (e.message.endsWith('\\n') ? '' : '\\n'));
        exitCode = 1;
      } else {
        globalThis.__nimbusPyStderr.push('[python-runner] unknown error: ' + e + '\\n');
        exitCode = 1;
      }
    }
  }

  try { userGlobals?.destroy?.(); } catch {}

    return {
      exitCode: exitCode,
      stdout: globalThis.__nimbusPyStdout.slice(stdoutStart).join(''),
      stderr: globalThis.__nimbusPyStderr.slice(stderrStart).join(''),
      fsDiff: __nimbusSnapshotPyDiff(pyodideMod, args.fsSnapshot),
    };
  } finally {
    pyodideMod.FS.ignorePermissions = previousIgnorePermissions;
  }
};

// ── END: python-runner preamble ───────────────────────────────────────
`;
}
