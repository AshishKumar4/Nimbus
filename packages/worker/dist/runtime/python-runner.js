/**
 * python-runner.ts — Pyodide v0.29.4 runner (runtime package manager v2 / Pyodide v1).
 *
 * D1-D7:
 *   - `python --version` / `python -c '<code>'` / `python script.py`
 *   - stdlib subset (full python_stdlib.zip ships)
 *   - stdout/stderr → processLogs (Process tab integration)
 *   - exit code via sys.exit(N) or unhandled exception → 1
 *   - argv passed through to sys.argv
 *
 * Current limits:
 *   - REPL mode (`python` with no args)
 *   - Native Linux wheels, runtime-loaded extension modules, and extension builds
 *   - Sync HTTP (urllib3 / requests blocked without JSPI)
 *
 * Architecture: SAME LOADER-modules transport as clang-runner/wasm-
 * runner. The Pyodide wasm bytes ship via the LOADER `modules` map
 * (CSP allows wasm code-gen at module-load time, not at request
 * time). The workerd-adapted Pyodide.asm.js artifact and stdlib zip ride via
 * the loader-pool `context` field (JSON-stringified into the inner worker.js
 * at module-load).
 *
 * Per wasm-csp/findings.md §4b: Pyodide.asm.wasm (10.1 MB on disk)
 * compiles in 314 ms via LOADER on PROD. With our v1 deployment of
 * 0.29.4 (8.25 MB asm.wasm), this is well under the empirical
 * ~32 MiB per-call ceiling.
 */
import { flushVfsDiff, snapshotVfs } from './vfs-snapshot.js';
import { createLiveStaticServerCode, parsePort } from './static-server.js';
import { parentVfsPath, resolveVfsPath } from '../vfs/path.js';
import { VIRTUAL_SOCKET_KERNEL_SRC } from './virtual-socket-kernel.js';
import { PYTHON_SOCKET_SHIM } from './python-socket-shim.js';
import { readPyodideRuntimeFiles } from './pyodide-runtime-assets.js';
const PYTHON_SITE_PACKAGES_ROOT = 'home/user/.nimbus-python/site-packages';
const PYTHON_VERSION_FLAGS = new Set(['--version', '-V']);
const PYTHON_HELP_FLAGS = new Set(['--help', '-h']);
const IGNORED_PIP_INSTALL_FLAGS = new Set([
    '--upgrade',
    '-U',
    '--force-reinstall',
    '--no-cache-dir',
    '--user',
    '--disable-pip-version-check',
    '--prefer-binary',
    '--only-binary=:all:',
]);
const PIP_INSTALL_FLAGS_WITH_VALUE = new Set([
    '-i',
    '--index-url',
    '--extra-index-url',
    '-f',
    '--find-links',
    '--trusted-host',
    '--timeout',
    '--retries',
    '--platform',
    '--python-version',
    '--implementation',
    '--abi',
]);
/**
 * Build the python-runner factory. Called once at session init; the
 * returned factory binds the manifest + install root for each
 * registered entrypoint (`python`, `python3`).
 */
export function makePythonRunnerFactory(deps) {
    const { facetMgr, vfs } = deps;
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
            const argv = ctx.args || [];
            const cwd = ctx.cwd || '/home/user';
            const pipInvocation = binKind === 'pip' || binName === 'pip' || binName === 'pip3'
                ? buildPipInvocation(argv, binName, cwd, vfs)
                : buildPythonModulePipInvocation(argv, cwd, vfs);
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
                ctx.stdout.write(`Package support is limited to pure Python wheels and packages with pure fallbacks; native Linux wheels and runtime-loaded extension modules are not executable in Nimbus.\n`);
                return 0;
            }
            const staticServer = parsePythonHttpServer(argv, cwd);
            if (staticServer) {
                const code = createLiveStaticServerCode(staticServer.root);
                const command = `${binName} -m http.server ${staticServer.port}`;
                const spawned = facetMgr.spawn(code, command, staticServer.root, { port: staticServer.port });
                ctx.stdout.write(`Serving HTTP on 0.0.0.0 port ${staticServer.port} from /${staticServer.root}\n`);
                ctx.stdout.write(`[nimbus] started: pid=${spawned.pid} cmd="${command}" port=${staticServer.port}\n`);
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
                if (!vfs.exists(absPath)) {
                    ctx.stderr.write(`${binName}: ${parsed.scriptPath}: No such file or directory\n`);
                    return 2;
                }
                try {
                    userCode = new TextDecoder('utf-8').decode(vfs.readFile(absPath));
                }
                catch (e) {
                    ctx.stderr.write(`${binName}: ${parsed.scriptPath}: ${e?.message || e}\n`);
                    return 1;
                }
                progName = parsed.scriptPath;
                pyArgv = [parsed.scriptPath, ...parsed.scriptArgs];
            }
            else if (parsed.mode === 'stdin') {
                // Read all of stdin from ctx (lifo-sh wires it when the pipe
                // is filled). Pyodide receives it as the program source.
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
                userEnv.HOME = '/home/pyodide';
            if (!userEnv.PYTHONUNBUFFERED)
                userEnv.PYTHONUNBUFFERED = '1';
            if (userEnv.HOME === '/home/pyodide')
                userEnv.HOME = '/home/user';
            const revision = typeof vfs.revision === 'function' ? vfs.revision() : Date.now();
            let fsSnapshot = fsSnapshotCache && fsSnapshotCache.cwd === cwd && fsSnapshotCache.revision === revision
                ? fsSnapshotCache.result
                : null;
            if (!fsSnapshot) {
                fsSnapshot = snapshotVfs(vfs, cwd, { extraRoots: [PYTHON_SITE_PACKAGES_ROOT] });
                fsSnapshotCache = { cwd, revision, result: fsSnapshot };
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
                }, {
                    userCode,
                    pyArgv,
                    userEnv,
                    progName,
                    cwd,
                    fsSnapshot: fsSnapshot.snapshot,
                    asyncRun: true,
                    pyodidePackages: [],
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
                if (!runtimePromise) {
                    runtimePromise = createPythonFacetRuntime(facetMgr, {
                        asmWasmVfs,
                        asmJsVfs,
                        stdlibVfs,
                        lockfileVfs,
                        manifest,
                        vfs,
                    });
                }
                runtime = await runtimePromise;
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
                pyodidePackages: pipInvocation.mode === 'pip' && /^import micropip/m.test(pipInvocation.code) ? ['micropip'] : [],
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
function buildPythonModulePipInvocation(argv, cwd, vfs) {
    if (argv[0] !== '-m' || argv[1] !== 'pip') {
        return { mode: 'none', code: '', exitCode: 0 };
    }
    return buildPipInvocation(argv.slice(2), 'pip', cwd, vfs);
}
function buildPipInvocation(argv, binName, cwd, vfs) {
    const wantsVersion = argv.includes('--version') || argv.includes('-V');
    const wantsHelp = argv.length === 0 || argv.includes('--help') || argv.includes('-h');
    if (wantsVersion) {
        return {
            mode: 'pip',
            code: [
                'print("pip 24.3.1 (Nimbus Pyodide package bridge, Pyodide 0.29.4)")',
            ].join('\n'),
            exitCode: 0,
        };
    }
    if (wantsHelp) {
        return {
            mode: 'pip',
            code: [
                `print(${JSON.stringify(`Usage: ${binName} install <package> [package...]`)})`,
                'print("Nimbus pip installs pure Python wheels and packages with pure fallbacks.")',
                'print("Native Linux wheels and runtime-loaded extension modules are not executable in Nimbus.")',
            ].join('\n'),
            exitCode: 0,
        };
    }
    const command = argv[0];
    if (command !== 'install') {
        return {
            mode: 'none',
            code: '',
            error: `pip subcommand '${command || '(none)'}' is not supported yet; supported: install, --version, --help`,
            exitCode: 2,
        };
    }
    const plan = buildPipInstallPlan(argv.slice(1), cwd, vfs);
    if (plan.error) {
        return { mode: 'none', code: '', error: plan.error, exitCode: plan.exitCode };
    }
    return {
        mode: 'pip',
        code: [
            'import micropip',
            'import os',
            'import shutil',
            'import sys',
            `packages = ${JSON.stringify(plan.packages)}`,
            `display_packages = ${JSON.stringify(plan.displayPackages)}`,
            `install_deps = ${plan.deps ? 'True' : 'False'}`,
            `target_site_packages = "/home/user/.nimbus-python/site-packages"`,
            'os.makedirs(target_site_packages, exist_ok=True)',
            'if target_site_packages not in sys.path:',
            '    sys.path.insert(0, target_site_packages)',
            'source_site_packages = next((p for p in sys.path if isinstance(p, str) and p.startswith("/lib/python") and p.endswith("/site-packages") and os.path.isdir(p)), None)',
            'before_entries = set(os.listdir(source_site_packages)) if source_site_packages else set()',
            'def _nimbus_disable_unsupported_extensions():',
            '    disabled = []',
            '    roots = []',
            '    for p in sys.path:',
            '        if isinstance(p, str) and p and "site-packages" in p and os.path.isdir(p) and p not in roots:',
            '            roots.append(p)',
            '    for root in roots:',
            '        for dirpath, _dirnames, filenames in os.walk(root):',
            '            for name in filenames:',
            '                if not name.endswith((".so", ".pyd", ".dylib")):',
            '                    continue',
            '                path = os.path.join(dirpath, name)',
            '                try:',
            '                    os.remove(path)',
            '                    disabled.append(path)',
            '                except Exception:',
            '                    pass',
            '    return disabled',
            'await micropip.install(packages, keep_going=False, deps=install_deps)',
            'if source_site_packages:',
            '    for name in sorted(set(os.listdir(source_site_packages)) - before_entries):',
            '        src = os.path.join(source_site_packages, name)',
            '        dst = os.path.join(target_site_packages, name)',
            '        if os.path.isdir(dst):',
            '            shutil.rmtree(dst)',
            '        elif os.path.exists(dst):',
            '            os.remove(dst)',
            '        if os.path.isdir(src):',
            '            shutil.copytree(src, dst)',
            '        else:',
            '            shutil.copy2(src, dst)',
            'disabled_extensions = _nimbus_disable_unsupported_extensions()',
            'if disabled_extensions:',
            '    names = ", ".join(os.path.basename(p) for p in disabled_extensions[:8])',
            '    if len(disabled_extensions) > 8:',
            '        names += " ..."',
            '    print("Nimbus pip: disabled unsupported Python extension module(s): " + names)',
            'print("Successfully installed " + " ".join(display_packages))',
        ].join('\n'),
        exitCode: 0,
    };
}
function buildPipInstallPlan(argv, cwd, vfs) {
    const packages = [];
    const displayPackages = [];
    let deps = true;
    const addSpec = (rawSpec, baseDir) => {
        const normalized = normalizePipInstallSpec(rawSpec, baseDir, vfs);
        if ('error' in normalized)
            return normalized.error;
        packages.push(normalized.installSpec);
        displayPackages.push(normalized.displaySpec);
        return null;
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-r' || arg === '--requirement') {
            const reqPath = argv[i + 1];
            if (!reqPath)
                return { packages, displayPackages, deps, error: `${arg}: missing requirements file`, exitCode: 2 };
            const err = addRequirementsFile(reqPath, cwd, vfs, packages, displayPackages, new Set(), 0);
            if (err)
                return { packages, displayPackages, deps, error: err, exitCode: 1 };
            i++;
            continue;
        }
        if (arg.startsWith('--requirement=')) {
            const reqPath = arg.slice('--requirement='.length);
            const err = addRequirementsFile(reqPath, cwd, vfs, packages, displayPackages, new Set(), 0);
            if (err)
                return { packages, displayPackages, deps, error: err, exitCode: 1 };
            continue;
        }
        if (arg === '--no-deps') {
            deps = false;
            continue;
        }
        if (isIgnoredPipInstallFlag(arg)) {
            continue;
        }
        if (pipFlagTakesValue(arg)) {
            if (!argv[i + 1])
                return { packages, displayPackages, deps, error: `${arg}: missing value`, exitCode: 2 };
            i++;
            continue;
        }
        if (arg.startsWith('-')) {
            return { packages, displayPackages, deps, error: `pip install option '${arg}' is not supported in Nimbus yet`, exitCode: 2 };
        }
        const err = addSpec(arg, cwd);
        if (err)
            return { packages, displayPackages, deps, error: err, exitCode: 1 };
    }
    if (packages.length === 0) {
        return { packages, displayPackages, deps, error: 'pip install: missing package name', exitCode: 2 };
    }
    return { packages, displayPackages, deps, exitCode: 0 };
}
function addRequirementsFile(reqPath, baseDir, vfs, packages, displayPackages, seen, depth) {
    if (depth > 8)
        return 'requirements nesting exceeded 8 files';
    const abs = resolveVfsPath(reqPath, baseDir);
    if (seen.has(abs))
        return null;
    seen.add(abs);
    if (!vfs.exists(abs))
        return `requirements file not found: ${reqPath}`;
    let text = '';
    try {
        text = new TextDecoder('utf-8').decode(vfs.readFile(abs));
    }
    catch (e) {
        return `cannot read requirements file ${reqPath}: ${e?.message || e}`;
    }
    const nextBaseDir = parentVfsPath(abs);
    for (const line of logicalRequirementLines(text)) {
        const trimmed = trimRequirementComment(line);
        if (!trimmed)
            continue;
        const tokens = splitRequirementArgs(trimmed);
        if (tokens.length === 0)
            continue;
        const head = tokens[0];
        if (head === '-r' || head === '--requirement') {
            if (!tokens[1])
                return `${reqPath}: ${head}: missing requirements file`;
            const err = addRequirementsFile(tokens[1], nextBaseDir, vfs, packages, displayPackages, seen, depth + 1);
            if (err)
                return err;
            continue;
        }
        if (head.startsWith('--requirement=')) {
            const err = addRequirementsFile(head.slice('--requirement='.length), nextBaseDir, vfs, packages, displayPackages, seen, depth + 1);
            if (err)
                return err;
            continue;
        }
        if (head === '-c' || head === '--constraint' || head.startsWith('--constraint=')) {
            return `${reqPath}: constraints are not supported by Nimbus pip yet`;
        }
        if (head.startsWith('--hash='))
            continue;
        if (head.startsWith('-'))
            continue;
        const normalized = normalizePipInstallSpec(head, nextBaseDir, vfs);
        if ('error' in normalized)
            return normalized.error;
        packages.push(normalized.installSpec);
        displayPackages.push(normalized.displaySpec);
    }
    return null;
}
function logicalRequirementLines(text) {
    const out = [];
    let current = '';
    for (const rawLine of text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
        const line = rawLine.trimEnd();
        if (line.endsWith('\\')) {
            current += line.slice(0, -1) + ' ';
            continue;
        }
        out.push(current + line);
        current = '';
    }
    if (current)
        out.push(current);
    return out;
}
function trimRequirementComment(line) {
    let quote = '';
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (ch === quote)
                quote = '';
            if (ch === '\\')
                i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '#') {
            const prev = i === 0 ? ' ' : line[i - 1];
            if (i === 0 || prev === ' ' || prev === '\t')
                return line.slice(0, i).trim();
        }
    }
    return line.trim();
}
function splitRequirementArgs(line) {
    const out = [];
    let cur = '';
    let quote = '';
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (ch === quote) {
                quote = '';
            }
            else if (ch === '\\' && i + 1 < line.length) {
                cur += line[++i];
            }
            else {
                cur += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === ' ' || ch === '\t') {
            if (cur) {
                out.push(cur);
                cur = '';
            }
            continue;
        }
        cur += ch;
    }
    if (cur)
        out.push(cur);
    return out;
}
function normalizePipInstallSpec(rawSpec, baseDir, vfs) {
    if (!rawSpec)
        return { error: 'empty requirement' };
    let spec = rawSpec;
    if (spec.startsWith('file://'))
        spec = spec.slice('file://'.length);
    const looksLikePath = spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../') || spec.endsWith('.whl');
    if (!looksLikePath)
        return { installSpec: spec, displaySpec: spec };
    const abs = resolveVfsPath(spec, baseDir);
    if (!vfs.exists(abs))
        return { error: `local wheel not found: ${rawSpec}` };
    const fileName = abs.slice(abs.lastIndexOf('/') + 1);
    if (!fileName.endsWith('.whl')) {
        return { error: `local installs currently require a .whl file: ${rawSpec}` };
    }
    const wheelError = validatePyodideWheelFileName(fileName);
    if (wheelError)
        return { error: wheelError };
    return {
        installSpec: `emfs:/${abs}`,
        displaySpec: fileName.slice(0, -'.whl'.length),
    };
}
function validatePyodideWheelFileName(fileName) {
    const stem = fileName.endsWith('.whl') ? fileName.slice(0, -4) : fileName;
    const parts = stem.split('-');
    if (parts.length < 5)
        return `invalid wheel filename: ${fileName}`;
    const pythonTag = parts[parts.length - 3].toLowerCase();
    const abiTag = parts[parts.length - 2].toLowerCase();
    const platformTag = parts[parts.length - 1].toLowerCase();
    if (platformTag === 'any' && abiTag === 'none')
        return null;
    if (platformTag.includes('manylinux') ||
        platformTag.includes('musllinux') ||
        platformTag.includes('linux') ||
        platformTag.includes('macosx') ||
        platformTag.includes('win')) {
        return `native Linux wheel '${fileName}' cannot run in Nimbus; install a pure wheel or a package with a pure Python fallback`;
    }
    if (platformTag.includes('emscripten') || platformTag.includes('wasm32')) {
        return `Pyodide/Emscripten extension wheel '${fileName}' needs precompiled runtime-module support; install a pure wheel or a package with a pure Python fallback`;
    }
    if (pythonTag.startsWith('py') && platformTag === 'any')
        return null;
    return `wheel '${fileName}' targets unsupported platform '${platformTag}'; Nimbus pip supports pure Python wheels and packages with pure Python fallbacks`;
}
function isIgnoredPipInstallFlag(arg) {
    return IGNORED_PIP_INSTALL_FLAGS.has(arg);
}
function pipFlagTakesValue(arg) {
    if (arg.includes('='))
        return false;
    return PIP_INSTALL_FLAGS_WITH_VALUE.has(arg);
}
function hasLeadingCliFlag(argv, flags) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (flags.has(arg))
            return true;
        if (arg === '--')
            return false;
        if (arg === '-c' || arg === '-m' || arg === '-')
            return false;
        if (!arg.startsWith('-'))
            return false;
    }
    return false;
}
function parsePythonHttpServer(argv, cwd) {
    if (argv[0] !== '-m' || argv[1] !== 'http.server')
        return null;
    let port = 8000;
    let directory = cwd;
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--directory') {
            directory = argv[i + 1] || directory;
            i++;
            continue;
        }
        if (arg.startsWith('--directory=')) {
            directory = arg.slice('--directory='.length) || directory;
            continue;
        }
        if (arg === '--bind' || arg === '-b') {
            i++;
            continue;
        }
        if (!arg.startsWith('-') && /^\d+$/.test(arg)) {
            port = parsePort(arg, port);
        }
    }
    return { port, root: resolveVfsPath(directory, cwd) };
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
function buildPythonRuntimeAssets(args) {
    const files = readPyodideRuntimeFiles(args);
    return {
        asmWasmBytes: files.asmWasmBytes,
        preamble: buildPyodidePreamble(files.asmJsSrc, files.stdlibB64, files.lockfileText),
    };
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
            pyodidePackages: inArgs.pyodidePackages || [],
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
            pyodidePackages: args.pyodidePackages || [],
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
async function spawnPythonSocketProcess(facetMgr, assetPaths, args, command) {
    const toAB = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const assets = buildPythonRuntimeAssets(assetPaths);
    const workerCode = buildPythonSocketProcessWorker(assets.preamble);
    const spawned = facetMgr.spawnWorker(workerCode, command, args.cwd, {
        compatibilityFlags: ['nodejs_compat'],
        modules: {
            'pyodide.asm.wasm': { wasm: toAB(assets.asmWasmBytes) },
        },
    });
    const bootResponse = await spawned.facetStub.fetch(new Request('http://nimbus.internal/__nimbus_start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userCode: args.userCode,
            pyArgv: args.pyArgv,
            userEnv: args.userEnv,
            progName: args.progName,
            cwd: args.cwd,
            fsSnapshot: args.fsSnapshot,
        }),
    }));
    const boot = await bootResponse.json().catch(() => null);
    if (!bootResponse.ok || !boot) {
        facetMgr.finishProcess(spawned.pid, 1, 'python process boot failed');
        return {
            exitCode: 1,
            stdout: '',
            stderr: `python process boot failed: HTTP ${bootResponse.status}\n`,
        };
    }
    if (boot.state === 'listening' && boot.port > 0) {
        facetMgr.registerPort(spawned.pid, Number(boot.port), spawned.facetStub);
        return {
            exitCode: 0,
            stdout: `${boot.stdout || ''}\x1b[2m[started (long-running): pid=${spawned.pid} cmd="${command}" port=${boot.port}]\x1b[0m\n`,
            stderr: boot.stderr || '',
            spawnedPid: spawned.pid,
            port: Number(boot.port),
        };
    }
    const reservedPorts = facetMgr.attachReservedPorts(spawned.pid, spawned.facetStub);
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
function buildPythonSocketProcessWorker(preamble) {
    return [
        'import { WorkerEntrypoint } from "cloudflare:workers";',
        "import __NIMBUS_WASM_pyodide_asm_wasm from './pyodide.asm.wasm';",
        'globalThis.__NIMBUS_WASM = globalThis.__NIMBUS_WASM || {};',
        "globalThis.__NIMBUS_WASM['pyodide.asm.wasm'] = __NIMBUS_WASM_pyodide_asm_wasm;",
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
        '        pyodidePackages: [],',
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
        '  async fetch(request) {',
        '    globalThis.__nimbusPythonSupervisor = this.env?.SUPERVISOR;',
        '    const url = new URL(request.url);',
        '    if (url.pathname === "/__nimbus_start") {',
        '      const args = await request.json();',
        '      const boot = await __nimbusStartPythonProcess(args);',
        '      return Response.json(boot);',
        '    }',
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
async function createPythonFacetRuntime(facetMgr, args) {
    const toAB = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const assets = buildPythonRuntimeAssets(args);
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
export function buildPyodidePreamble(asmJsSrc, stdlibB64, lockfileContents = '{"packages":{}}') {
    return [
        '// ── Pre-asm.js environment shims ───────────────────────────────',
        '// Pyodide.asm.js detects its environment via heuristics. In',
        '// workerd, several detections fire wrong:',
        '//   - ENVIRONMENT_IS_NODE: workerd defines process + process.versions.node',
        '//     under nodejs_compat → Pyodide tries require("fs"), require("path"),',
        '//     require("crypto"), require("ws"), require("child_process"). We',
        '//     don\'t want any of those code paths because instantiateWasm is',
        '//     overridden anyway.',
        '//   - ENVIRONMENT_IS_WORKER (typeof WorkerGlobalScope !== "undefined"):',
        '//     true in workerd. Pyodide reads `self.location.href`. workerd has',
        '//     `self` (== globalThis) but `self.location` is undefined. Stub it.',
        '//   - document.currentScript?.src: workerd has no document; the',
        '//     optional-chain on undefined is fine, but we shim it explicitly',
        '//     to remove any drift across pyodide versions.',
        '//',
        '// CRITICAL: ENVIRONMENT_IS_NODE is computed inside the async-factory',
        '// returned by the asm.js IIFE — i.e., it\'s evaluated WHEN',
        '// _createPyodideModule(settings) is CALLED, not when the asm.js',
        '// module-init runs. We therefore need to keep globalThis.process =',
        '// undefined across that call, not just the asm.js inline above. The',
        '// __pyodideRun helper below does the save+restore around the call.',
        '// IMPORTANT: env-detection in asm.js happens at the IIFE OUTER scope',
        '// (runs at module-load time, during the asm.js inline below), via',
        '//   var f = oe();',
        '// `oe()` reads globalThis.process / typeof WorkerGlobalScope / typeof',
        '// self instanceof WorkerGlobalScope and stores derived flags in `f`',
        '// (captured into closure scope as `d`). Later inside the async factory',
        '// (at request time), loadScript selects on `d.IN_BROWSER_WEB_WORKER`.',
        '//',
        '// So the shims MUST be in place BEFORE the asm.js inline runs.',
        '// __pyodideRun\'s save+restore around _createPyodideModule covers the',
        '// inner async factory call BUT NOT this outer IIFE evaluation. We',
        '// therefore stub at module-load too, save the originals, and restore',
        '// AT THE END OF THE PREAMBLE (after the asm.js inline returns).',
        'const __nimbusOrigProcess = globalThis.process;',
        'const __nimbusOrigWGS = globalThis.WorkerGlobalScope;',
        'try { globalThis.process = undefined; } catch (e) { /* non-writable; fall through */ }',
        '// Defense in depth: if globalThis.process survived the = undefined',
        '// (workerd treats it as non-configurable in some setups), mark it',
        '// browser-like so Pyodide\'s `!process.browser` check fails → IN_NODE = false.',
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
        '// pyodide_js_init() inside the asm.js IIFE constructs a FinalizationRegistry',
        '// to bridge JS-side GC to Python ref-cleanup. workerd does not expose',
        '// FinalizationRegistry by default (it is gated behind the `enable_weak_ref`',
        '// compat flag, on by default after 2025-05-05). For older compat dates',
        '// the constructor is undefined and pyodide_js_init throws ReferenceError.',
        '// Provide a no-op class shim — registered callbacks are simply never',
        '// invoked. This is memory-leaky for long-lived workers (Python objects',
        '// holding JS proxies will be retained beyond their natural lifetime),',
        '// but acceptable for v1 (per-request bootstrap; workerd reaps on isolate',
        '// reuse anyway). Future v3: switch to compat_date >= 2025-05-05 and drop.',
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
        buildPreambleTail(stdlibB64, lockfileContents),
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
function buildPreambleTail(stdlibB64, lockfileContents) {
    return `
// ── BEGIN: python-runner preamble tail (Pyodide 0.29.4, Nimbus v2) ──

// Stdlib bytes spliced into preamble at facet-build time. ~3.2 MiB
// base64 text — decoded once at module-init. Same content as
// share/pyodide/python_stdlib.zip in the runtime cache.
const __NIMBUS_STDLIB_B64 = ${JSON.stringify(stdlibB64)};
const __NIMBUS_LOCKFILE_CONTENTS = ${JSON.stringify(lockfileContents)};
const __NIMBUS_PERSISTENT_SITE_PACKAGES = '/home/user/.nimbus-python/site-packages';
const __NIMBUS_PYTHON_SOCKET_SHIM = ${JSON.stringify(PYTHON_SOCKET_SHIM)};

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

function __nimbusB64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

function __nimbusNormPath(path) {
  const clean = String(path || '').replace(/^\\/+/, '').replace(/\\/+$/, '');
  return clean ? '/' + clean : '/';
}

function __nimbusInstallFsSnapshot(M, snapshot) {
  if (!snapshot || !snapshot.root) return;
  const currentFiles = new Set(Object.keys(snapshot.files || {}));
  const previous = globalThis.__nimbusMountedPyFiles || new Set();
  for (const prev of Array.from(previous)) {
    if (currentFiles.has(prev)) continue;
    try {
      const abs = __nimbusNormPath(prev);
      if (M.FS.analyzePath(abs).exists) M.FS.unlink(abs);
    } catch {}
  }
  const dirs = Array.from(new Set(snapshot.dirs || [])).sort((a, b) => a.length - b.length);
  for (const dir of dirs) {
    try { M.FS.mkdirTree(__nimbusNormPath(dir)); } catch {}
  }
  for (const [path, b64] of Object.entries(snapshot.files || {})) {
    const abs = __nimbusNormPath(path);
    try {
      const parent = abs.slice(0, abs.lastIndexOf('/')) || '/';
      M.FS.mkdirTree(parent);
      M.FS.writeFile(abs, __nimbusB64ToBytes(b64));
    } catch (e) {
      globalThis.__nimbusPyStderr.push('[python-runner] VFS mount failed for ' + path + ': ' + (e && e.message) + '\\n');
    }
  }
  globalThis.__nimbusMountedPyFiles = currentFiles;
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

  // Apply user env to MEMFS now that CPython is up. (The preRun setEnv
  // ran with bootstrap defaults; we layer the user env on top.)
  if (args.userEnv) {
    try { Object.assign(pyodideMod.ENV, args.userEnv); } catch {}
  }
  try {
    __nimbusInstallFsSnapshot(pyodideMod, args.fsSnapshot);
    try {
      pyodideMod.FS.mkdirTree(__NIMBUS_PERSISTENT_SITE_PACKAGES);
      pyodideMod.API.sitePackages = __NIMBUS_PERSISTENT_SITE_PACKAGES;
    } catch {}
    const cwd = __nimbusNormPath(args.cwd || (args.userEnv && args.userEnv.HOME) || '/home/user');
    try { pyodideMod.FS.mkdirTree(cwd); } catch {}
    try { pyodideMod.FS.chdir(cwd); } catch {}
  } catch (e) {
    globalThis.__nimbusPyStderr.push('[python-runner] VFS mount failed: ' + (e && e.message) + '\\n');
  }

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
  const argv = [args.progName].concat((args.pyArgv || []).slice(0));
  // If pyArgv already includes the script as [0], use it directly.
  // Convention from the python-runner caller: pyArgv = [progName,
  // ...args]. We set sys.argv = pyArgv with [0] = progName.
  const effectiveArgv = (args.pyArgv && args.pyArgv.length > 0) ? args.pyArgv : argv;

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

  try {
    pyodide.runPython(
      'import os, sys\\n' +
	      'sys.argv = ' + JSON.stringify(effectiveArgv) + '\\n' +
	      'cwd = ' + JSON.stringify(args.cwd || '/home/user') + '\\n' +
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
      if (Array.isArray(args.pyodidePackages) && args.pyodidePackages.length > 0) {
        for (const pkg of args.pyodidePackages) {
          await pyodide.loadPackage(pkg);
        }
      }
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
      // Check onExit-captured code first (set by Emscripten's ExitStatus
      // path before the throw).
      if (typeof globalThis.__nimbusExitCode === 'number') {
        exitCode = globalThis.__nimbusExitCode;
      } else if (e && typeof e.message === 'string') {
        // Fall back to message parsing. Pyodide surfaces SystemExit as
        // a PythonError with message containing "SystemExit: <code>".
        const m = e.message.match(/SystemExit:\\s*(-?\\d+)/);
        if (m) {
          exitCode = parseInt(m[1], 10);
        } else if (/SystemExit/.test(e.message)) {
          // SystemExit with no numeric arg (e.g., sys.exit() or sys.exit(None))
          exitCode = 0;
        } else {
          globalThis.__nimbusPyStderr.push(e.message + (e.message.endsWith('\\n') ? '' : '\\n'));
          exitCode = 1;
        }
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
};

// ── END: python-runner preamble ───────────────────────────────────────
`;
}
