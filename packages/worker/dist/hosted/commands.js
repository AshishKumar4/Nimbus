import { Shell, createCurlCommand, createNpmCommand, NPM_VERSION, createTopCommand, createWatchCommand, createHelpCommand, rehydrateGlobalPackages } from '@nimbus-sh/core/substrate/lifo/index.js';
import { createKillCommand } from '@nimbus-sh/core/substrate/lifo/commands/system/kill.js';
import { textSink } from '@nimbus-sh/core/_shared/bytes.js';
import { BASH_RUNNER, CRED_KERNEL, requireVfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { ExecutionFs } from '@nimbus-sh/core/shell/execution-fs.js';
import { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { runFresh } from '../runtime/node-runner.js';
import { runBunScript, BUN_VERSION } from '../runtime/bun-runner.js';
import { buildRuntimeHandler, resolveRuntimeScriptPath } from '@nimbus-sh/core/runtime/runtime-registry.js';
import { normalizeVfsPath, parentVfsPath, resolveVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { NimbusWrangler } from '../wrangler/nimbus-wrangler.js';
import { filterWranglerFlags, detectBundlerBin, checkNodeModulesGuard, detectUnsupportedWranglerConfig, refusedNextSubcommand, NEXT_REFUSAL_MESSAGE } from '../session/helpers.js';
import { createViteCommand } from '../session/vite-command.js';
import { HeredocHandler, LineEditorExtender } from '@nimbus-sh/core/shell/features.js';
import { registerShellEntrypointCommands } from '@nimbus-sh/core/shell/shell-entrypoints.js';
import { makeChshCommand } from '@nimbus-sh/core/substrate/lifo/shell/default-shell.js';
import { installNpmBinFallbackResolver } from '../shell/npm-bin-entrypoints.js';
import { createNpmInstallPort } from '../session/npm-install-port.js';
import { createRuntimeCommandHintResolver } from '../runtime/package-manager.js';
import { rpcExposeApp, rpcListApps, rpcRemoveApp, rpcRotateLink } from '../session/programmatic.js';
import { listInstalledRuntimes } from '@nimbus-sh/core/runtime/installed-runtimes.js';
import { notifyTerminalEvent } from '../runtime/process-logs-api.js';
import { stripAnsi } from '@nimbus-sh/core/runtime/process-logs.js';
import { NODE_VERSION } from '@nimbus-sh/core/constants.js';
import { VITE_CONFIG_KEY } from '../session/keys.js';
import { HeadlessTerminal } from '@nimbus-sh/core/substrate/lifo/index.js';
import { makeNimbusVerbHandler } from '@nimbus-sh/core/runtime/nimbus-command.js';
export async function registerHostedCommands(self, workspace) {
    const sqliteFs = workspace.vfs;
    const kernelFs = sqliteFs.as(CRED_KERNEL);
    const kernel = workspace.kernel;
    const shell = workspace.shell;
    const registry = workspace.registry;
    const processRegistry = kernel.processRegistry;
    const env = workspace.env;
    const terminal = self.terminal;
    if (!terminal)
        throw new Error('runtime terminal is not initialized');
    const facetMgr = self.ensureFacetManager().manager;
    const runAsProcess = shell.getRunAsHost();
    const commandIdentityFor = (pid) => ({
        pid,
        get cred() { return self.processes.cred(pid); },
        setUmask: (mask) => self.processes.setUmask(pid, mask),
        runAs: runAsProcess,
    });
    self._setCpRegistry(registry);
    registry.register('chsh', makeChshCommand({
        isBashInstalled: async (home) => (await listInstalledRuntimes(sqliteFs, home)).some((runtime) => runtime.name === 'bash'),
    }));
    // ── Git integration (isomorphic-git) ──
    // ctx + env are passed for clone/fetch/pull which run in a facet to avoid
    // exhausting the supervisor DO's CPU budget on large repos. The command
    // module (+ its ~106 KB network-facet dependency) is loaded lazily on the
    // first `git` invocation so it stays out of the cold script-eval graph.
    registry.register('git', async (ctx) => {
        const { runGitCommand } = await import('../git/commands.js');
        return runGitCommand(ctx, sqliteFs, self.ctx, self.env);
    });
    // ── runtime package manager: `nimbus install` package manager + runner registry.
    //
    // 1. Register the clang-runner factory FIRST so the rehydration step
    //    below can re-bind `clang` / `wasm-ld` from an already-installed
    //    manifest.
    // 2. Register the `nimbus` shell verb (install/uninstall/list/available).
    // 3. Rehydrate any previously-installed runtimes from VFS so their
    //    bins reappear in the registry after DO eviction or WS reconnect.
    workspace.runtimes.registerRunner('clang-runner', (manifest, installRoot, binName, binKind) => async (ctx) => {
        const { makeClangRunnerFactory } = await import('@nimbus-sh/core/runtime/clang-runner.js');
        const { facetHostForManager } = await import('../runtime/facet-loader-host.js');
        return await makeClangRunnerFactory({ facets: facetHostForManager(facetMgr), filesystem: workspace.filesystem })(manifest, installRoot, binName, binKind)(ctx);
    });
    // Pyodide v1 — Python 3.13 via the same R2-package-manager
    // substrate that ships clang. Manifest entrypoints `python` and
    // `python3` both bind to this factory; the runner ferries
    // pyodide.asm.wasm via LOADER modules-map and pyodide.asm.js +
    // python_stdlib.zip via the loader-pool context channel.
    //
    // REPL-W1: wrap the one-shot factory so `python` with NO args (and
    // no flags that would consume args) drops into an interactive
    // REPL. The wrap is purely additive — args-bearing invocations
    // pass through to the existing handler unchanged.
    workspace.runtimes.registerRunner('cpython-runner', (manifest, installRoot, binName, binKind) => async function pythonReplOrOneShot(ctx) {
        const argv = ctx.args || [];
        // No args at all → REPL session. Hand off to runPythonRepl
        // which builds its own IsolatePool (separate from the
        // one-shot dispatch's pool) and drives a ReplSession.
        if (argv.length === 0 && terminal) {
            const { runPythonRepl } = await import('../runtime/python-repl.js');
            return await runPythonRepl({
                facetMgr,
                authority: workspace.filesystem,
                terminal: terminal,
                installRoot,
                manifest,
                // REPL-R7-1: thread the shell so ReplSession can drain
                // shell.pasteQueue on attach (multi-line WS frames like
                // `python\nexit(7)` would otherwise drop the tail input).
                shell: shell,
                // The supervisor derives the write credential from this; without
                // it the prompt cannot write to the session filesystem.
                pid: ctx.pid,
            });
        }
        // Args present (one-shot mode: -c, script, -m, -). Fall through
        // to the canonical handler (imported lazily on first use).
        const { makeCPythonRunnerFactory } = await import('@nimbus-sh/core/runtime/cpython-runner.js');
        const { facetHostForManager } = await import('../runtime/facet-loader-host.js');
        const { cpythonResidentStart } = await import('../runtime/cpython-resident.js');
        return await makeCPythonRunnerFactory({
            facets: facetHostForManager(facetMgr),
            startResident: cpythonResidentStart(facetMgr),
        })(manifest, installRoot, binName, binKind)(ctx);
    });
    // Ruby v1 — Ruby 3.3.4 via ruby.wasm 2.9.3-2.9.4. Same architecture
    // as python-runner: ruby+stdlib.wasm rides via LOADER modules-map,
    // bootstrap runs at child-facet module-init time, per-call
    // __rubyRun drives rb-eval-string-protect with a wrapper that
    // catches SystemExit. See src/runtime/ruby-runner.ts +
    //
    // REPL Stream A: wrap the one-shot factory so `ruby` with NO args
    // drops into an interactive REPL. The wrap is purely additive —
    // args-bearing invocations pass through to the existing handler.
    workspace.runtimes.registerRunner('ruby-runner', (manifest, installRoot, binName, binKind) => async function rubyReplOrOneShot(ctx) {
        const argv = ctx.args || [];
        if (argv.length === 0 && terminal) {
            const { runRubyRepl } = await import('../runtime/ruby-repl.js');
            return await runRubyRepl({
                facetMgr,
                authority: workspace.filesystem,
                terminal: terminal,
                installRoot,
            });
        }
        const { makeRubyRunnerFactory } = await import('@nimbus-sh/core/runtime/ruby-runner.js');
        const { facetHostForManager } = await import('../runtime/facet-loader-host.js');
        const { rubyResidentStart } = await import('../runtime/ruby-resident.js');
        const runner = await makeRubyRunnerFactory({
            facets: facetHostForManager(facetMgr),
            filesystem: workspace.filesystem,
            registry,
            startResident: rubyResidentStart(facetMgr),
        })(manifest, installRoot, binName, binKind);
        return runner(ctx);
    });
    // GNU bash 5.2.37 (wasm32-wasi, asyncified) — dedicated facet
    // runner driving the fork/pipe/exec/setjmp scheduler (fork M1-M3
    // mechanisms). Interactive terminal invocations use the shared
    // ReplSession line editor; -c, scripts, and piped stdin retain the
    // canonical one-shot handler.
    workspace.runtimes.registerRunner(BASH_RUNNER, (manifest, installRoot, binName, binKind) => async (ctx) => {
        const argv = ctx.args || [];
        const explicitInteractive = argv.includes('-i');
        const terminalStdin = ctx.isFdTerminal?.(0) ?? !ctx.stdin;
        if (terminal && (explicitInteractive || (argv.length === 0 && terminalStdin))) {
            const { runBashRepl } = await import('../runtime/bash-repl.js');
            return await runBashRepl({
                facetMgr,
                authority: workspace.filesystem,
                terminal: terminal,
                installRoot,
                manifest,
                cred: ctx.cred,
                pid: ctx.pid,
                filesystem: workspace.filesystem.bind({ pid: ctx.pid, cred: ctx.cred, signal: ctx.signal }),
                env: ctx.env,
                cwd: ctx.cwd || '/home/user',
                shell: shell ?? undefined,
            });
        }
        const { makeBashRunnerFactory } = await import('@nimbus-sh/core/runtime/bash-runner.js');
        const { facetHostForManager } = await import('../runtime/facet-loader-host.js');
        return await makeBashRunnerFactory({ facets: facetHostForManager(facetMgr), filesystem: workspace.filesystem })(manifest, installRoot, binName, binKind)(ctx);
    });
    {
        // Cast registry to the minimal package-manager shape. CommandRegistry
        // CommandRegistry has register(name, handler) which matches.
        registry.register('nimbus', makeNimbusVerbHandler({
            runtimes: workspace.runtimes,
            vfs: kernelFs,
            registry: registry,
            // The application verbs are the session's own (programmatic.ts):
            // the shell, the SDK and the Agent all reach the same policy.
            apps: {
                expose: (target, options) => rpcExposeApp(self, target, options),
                list: () => rpcListApps(self),
                rotateLink: (target) => rpcRotateLink(self, target),
                remove: (target) => rpcRemoveApp(self, target),
            },
            warmRuntime: async (target, ctx) => {
                // The runtime name, which is what `nimbus install python` installs
                // — not the name the user typed. Left as 'python' through the
                // migration, this matched only the superseded Pyodide entry, so the
                // interpreter people actually install was never warmed and the
                // first invocation after installing paid the wasm compile.
                if (target.name !== 'cpython')
                    return;
                ctx.stdout.write(`[${target.name}] warming runtime...\n`);
                const stdout = { write(_s) { } };
                const stderrText = [];
                const stderr = { write: (s) => { stderrText.push(String(s)); } };
                const py = await registry.resolve('python');
                if (py) {
                    const pid = ctx.pid;
                    const cred = requireVfsCred(ctx.cred, 'python warm-up');
                    const code = await py({
                        ...ctx,
                        args: ['-c', 'pass'],
                        pid,
                        cred,
                        setUmask: (mask) => ctx.setUmask(mask),
                        runAs: (targetCred, argv) => ctx.runAs(targetCred, argv),
                        vfs: new ExecutionFs(workspace.filesystem.bind({ pid, cred })),
                        signal: new AbortController().signal,
                        stdout,
                        stderr,
                    });
                    if (typeof code === 'number' && code !== 0) {
                        throw new Error(stderrText.join('').trim() || `python warm-up exited ${code}`);
                    }
                }
                const { warmPythonRepl } = await import('../runtime/python-repl.js');
                await warmPythonRepl({
                    facetMgr,
                    authority: workspace.filesystem,
                    installRoot: target.root,
                    manifest: target.manifest,
                });
                ctx.stdout.write('[python] ready\n');
            },
        }));
        // Rehydration runs here even though the shell hasn't been built
        // yet — that's fine: it accesses VFS + registry which are both
        // already initialised. Runs O(installed-runtimes); typically 0
        // on a fresh session.
        try {
            const rehydration = await workspace.runtimes.rehydrate();
            if (rehydration.count > 0) {
                // Surface to terminal via the standard MOTD-style line so
                // users see what's been auto-rebound. Not an error path.
                terminal?.write?.(`\x1b[2m[nimbus] rehydrated ${rehydration.count} runtime bin(s): ${rehydration.bins.join(', ')}\x1b[0m\r\n`);
            }
        }
        catch { /* fail-soft: rehydration must not block session boot */ }
    }
    // ── node command: facet-based execution ─────────────────────────────
    // Parses args, reads script from VFS, delegates to FacetManager.
    // The facet creates a dynamic worker where new Function() is allowed
    // during module startup.
    // ── node command (runtime registry refactor: refactored to use runtime-registry) ──
    //
    // Behaviour preserved exactly:
    //   - primitive #1 nodeFlagSpan (--version/-v/-h scan only flags
    //     before script path)
    //   - primitive #1 shebang strip
    //   - .ts/.tsx/.jsx esbuild auto-transform
    //   - G4 binSpawn ctx propagation (when the .bin handler set
    //     ctx.__nimbusBinSpawn, runFresh reuses the caller's PID
    //     instead of double-spawning)
    //   - --watch/--inspect/--inspect-brk routing via runFresh →
    //     isLongRunningInvocation
    //
    // The registry encodes the shared shape; per-runtime overrides
    // live in the spec object.
    const nodeSpec = {
        name: 'node',
        // CLN-1b: was stale literal 'v20.0.0'; pull from src/constants.ts
        // canonical (src/runtime/node-shims.ts already does the same).
        version: NODE_VERSION,
        helpText: 'Usage: node [options] [script.js] [arguments]\n' +
            '       node -e "code"\n\n' +
            'Options:\n' +
            '  -e, --eval <code>   Evaluate code\n' +
            '  -v, --version       Print version\n' +
            '  -h, --help          Print help\n' +
            '\nExecution via DO Facets (isolated V8 isolate)',
        run: (code, opts) => runFresh(facetMgr, code, opts),
        supportsBinSpawn: true,
    };
    {
        const oneShotNode = buildRuntimeHandler(nodeSpec, {
            getEsbuild: () => {
                if (!self.esbuildService) {
                    self.ensureSqliteFs();
                    self.esbuildService = new EsbuildService(kernelFs);
                }
                return self.esbuildService;
            },
            registry,
        });
        // REPL Stream A: no-args invocation → drop into REPL session.
        registry.register('node', async function nodeReplOrOneShot(ctx) {
            const argv = ctx.args || [];
            if (argv.length === 0 && terminal) {
                const { runNodeRepl } = await import('../runtime/node-repl.js');
                return await runNodeRepl({ facetMgr, terminal: terminal });
            }
            return await oneShotNode(ctx);
        });
    }
    // ── bun command (runtime registry refactor: refactored to use runtime-registry) ──
    //
    // Behaviour preserved exactly:
    //   - --version / --help
    //   - install / i / add → delegate to npm
    //   - run <script> → look up package.json#scripts and shell.execute
    //   - -e / --eval flow
    //   - script-path flow with .ts/.tsx/.jsx auto-transform
    //   - BUN_SHIM_PREAMBLE prepend (handled inside runBunScript itself)
    //
    // Bun does NOT use binSpawn ctx propagation today (its runFresh
    // chain doesn't share PID state with the .bin handler — the .bin
    // handler always dispatches through `node`, not `bun`). So
    // supportsBinSpawn=false (default).
    /** `scripts` from the cwd's package.json; empty when there is none. */
    const readPackageScripts = (cwd) => {
        try {
            const pkg = JSON.parse(kernelFs.readFileString(cwd + '/package.json'));
            const scripts = pkg?.scripts;
            return scripts && typeof scripts === 'object' ? scripts : {};
        }
        catch {
            return {};
        }
    };
    const bunSpec = {
        name: 'bun',
        version: BUN_VERSION,
        helpText: 'Usage: bun [options] [script.[js|ts|tsx]] [args...]\n' +
            '       bun -e "code"\n' +
            '       bun install [pkg ...]\n' +
            '       bun run <script>\n\n' +
            'Bun-runtime shim provides Bun.file/Bun.write/\n' +
            'Bun.spawn/Bun.password/Bun.gunzip backed by Workers-native\n' +
            'primitives. Bun.serve / Bun.sql / Bun.S3 throw with supported alternatives.\n' +
            'Execution via DO Facets (isolated V8 isolate per call).',
        run: (code, opts) => runBunScript(facetMgr, code, opts),
        subcommands: {
            // bun install / i / add → npm install (same VFS, same R2 caches).
            install: async (ctx, reg) => {
                const npmCmd = await reg.resolve('npm');
                if (npmCmd) {
                    return await npmCmd({ ...ctx, args: ['install', ...(ctx.args || []).slice(1)] });
                }
                ctx.stderr.write('bun install: npm handler unavailable\n');
                return 1;
            },
            i: async (ctx, reg) => {
                const npmCmd = await reg.resolve('npm');
                if (npmCmd) {
                    return await npmCmd({ ...ctx, args: ['install', ...(ctx.args || []).slice(1)] });
                }
                ctx.stderr.write('bun i: npm handler unavailable\n');
                return 1;
            },
            add: async (ctx, reg) => {
                const npmCmd = await reg.resolve('npm');
                if (npmCmd) {
                    return await npmCmd({ ...ctx, args: ['install', ...(ctx.args || []).slice(1)] });
                }
                ctx.stderr.write('bun add: npm handler unavailable\n');
                return 1;
            },
            // bun run <target> — a package.json script, or a file.
            //
            // Real bun's precedence, and the reason this is not just a script
            // lookup: a path-shaped target (`./cli.ts`, `sub/x`, `.`) is ALWAYS
            // a file and never consults scripts, while a bare name checks
            // scripts first and only then falls back to a file. The file case
            // delegates to the standard runtime flow, so `bun run ./cli.ts`
            // and `bun cli.ts` execute through one path — TypeScript transform,
            // facet dispatch and all.
            run: async (ctx, _reg, runAsBun) => {
                const args = ctx.args || [];
                // bun's own run flags sit between the verb and the target.
                let targetIdx = 1;
                while (targetIdx < args.length && args[targetIdx].startsWith('-'))
                    targetIdx++;
                const target = args[targetIdx];
                const cwd = normalizeVfsPath(ctx.cwd || '/home/user');
                const scripts = readPackageScripts(cwd);
                if (!target) {
                    ctx.stdout.write('Usage: bun run [flags] <file or script>\n');
                    const names = Object.keys(scripts);
                    if (names.length) {
                        ctx.stdout.write(`\npackage.json scripts (${names.length} found):\n\n`);
                        for (const n of names)
                            ctx.stdout.write(`  bun run ${n}\n    ${scripts[n]}\n\n`);
                    }
                    return 0;
                }
                const pathShaped = target === '.' || target === '..' || target.includes('/');
                const pkgScript = pathShaped ? undefined : scripts[target];
                if (pkgScript) {
                    // Trailing args append to the script command; bun drops a single
                    // `--` separator between the script name and them.
                    const extra = args.slice(targetIdx + 1);
                    if (extra[0] === '--')
                        extra.shift();
                    const command = extra.length ? `${pkgScript} ${extra.join(' ')}` : pkgScript;
                    try {
                        const shellResult = await shell.execute(command, {
                            cwd: ctx.cwd,
                            env: ctx.env,
                            onStdout: textSink((d) => ctx.stdout.write(d)),
                            onStderr: textSink((d) => ctx.stderr.write(d)),
                        });
                        return shellResult.exitCode;
                    }
                    catch (e) {
                        ctx.stderr.write(`bun run: ${e?.message ?? String(e)}\n`);
                        return 1;
                    }
                }
                const resolved = (await resolveRuntimeScriptPath(kernelFs, cwd, target, {
                    preferModuleField: true,
                }));
                if (resolved === null) {
                    ctx.stderr.write(pathShaped
                        ? `error: Module not found "${target}"\n`
                        : `error: Script not found "${target}"\n`);
                    return 1;
                }
                return runAsBun([...args.slice(1, targetIdx), '/' + resolved, ...args.slice(targetIdx + 1)]);
            },
        },
    };
    {
        const oneShotBun = buildRuntimeHandler(bunSpec, {
            getEsbuild: () => {
                if (!self.esbuildService) {
                    self.ensureSqliteFs();
                    self.esbuildService = new EsbuildService(kernelFs);
                }
                return self.esbuildService;
            },
            registry,
        });
        // REPL Stream A: no-args invocation → drop into REPL session.
        registry.register('bun', async function bunReplOrOneShot(ctx) {
            const argv = ctx.args || [];
            if (argv.length === 0 && terminal) {
                const { runBunRepl } = await import('../runtime/bun-repl.js');
                return await runBunRepl({ facetMgr, terminal: terminal });
            }
            return await oneShotBun(ctx);
        });
    }
    // ── wasm-runner: native WebAssembly, on this session's facet host ──
    //
    // Bytes ride INSIDE the inner worker's code blob, the one phase where
    // workerd permits wasm code generation; request-time
    // WebAssembly.instantiate(bytes) is CSP-blocked and avoided.
    //
    // wasm-csp/findings.md — add(3,4)===7 in 11ms warm against the
    // deployed Cloudflare fleet.
    //
    // Lazy: the wasm-runner module (WASI instance preamble + snapshot
    // machinery) is imported on first `wasm-runner` invocation and the
    // built handler memoized, so its module-eval cost stays off the cold
    // Worker Startup Time path.
    {
        let wasmHandler = null;
        registry.register('wasm-runner', async (ctx) => {
            if (!wasmHandler) {
                const { wasmRunnerSpec } = await import('@nimbus-sh/core/runtime/wasm-runner.js');
                const { loaderFacetHost } = await import('../runtime/facet-loader-host.js');
                const wasmSpec = wasmRunnerSpec({
                    filesystem: workspace.filesystem,
                    facets: loaderFacetHost(self.env, self.ctx),
                    processes: self.processes,
                });
                wasmHandler = buildRuntimeHandler(wasmSpec, {
                    getEsbuild: () => {
                        if (!self.esbuildService) {
                            self.ensureSqliteFs();
                            self.esbuildService = new EsbuildService(kernelFs);
                        }
                        return self.esbuildService;
                    },
                    registry,
                });
            }
            return await wasmHandler(ctx);
        });
    }
    kernel.routeLoopback = (port, request) => self.routeLoopback(port, request);
    try {
        registry.register('curl', createCurlCommand(kernel));
    }
    catch { }
    // ── df with SQLite stats + cache + process metrics ──────────────────
    registry.register('df', async (ctx) => {
        const stats = sqliteFs.getStats();
        const pstats = facetMgr.stats;
        const used = stats.usedBytes;
        const cap = stats.capacityBytes;
        const avail = cap - used;
        const pct = ((used / cap) * 100).toFixed(0);
        const fmt = (b) => {
            if (b >= 1e9)
                return (b / 1e9).toFixed(1) + 'G';
            if (b >= 1e6)
                return (b / 1e6).toFixed(1) + 'M';
            if (b >= 1e3)
                return (b / 1e3).toFixed(1) + 'K';
            return b + 'B';
        };
        ctx.stdout.write('Filesystem      Size  Used Avail Use% Mounted on\n');
        ctx.stdout.write('sqlite         ' + fmt(cap).padStart(5) + ' ' + fmt(used).padStart(5) +
            ' ' + fmt(avail).padStart(5) + ' ' + pct.padStart(3) + '% /\n');
        ctx.stdout.write('\nCache: ' + stats.cache.entries + '/' + stats.cache.maxEntries +
            ' slots | hit rate: ' + stats.cache.hitRate +
            '% | evictions: ' + stats.cache.evictions + '\n');
        ctx.stdout.write('Procs: ' + pstats.running + ' running, ' +
            pstats.exited + ' exited, ' +
            pstats.total + ' total (next PID: ' + pstats.nextPid + ')\n');
        return 0;
    });
    // ── esbuild command: transform/bundle via esbuild facet ───────────────
    // Lazy-creates the EsbuildService on first use (esbuild-wasm is ~10MB).
    registry.register('esbuild', async (ctx) => {
        const args = ctx.args || [];
        if (args.includes('--version')) {
            ctx.stdout.write('0.24.2 (esbuild-wasm, bundled)\n');
            return 0;
        }
        if (args.includes('--help') || args.length === 0) {
            ctx.stdout.write('Usage: esbuild [options] [entry points]\n\n');
            ctx.stdout.write('Options:\n');
            ctx.stdout.write('  --bundle           Bundle all dependencies into output\n');
            ctx.stdout.write('  --outfile=<path>   Write output to a file\n');
            ctx.stdout.write('  --outdir=<path>    Write output to a directory\n');
            ctx.stdout.write('  --format=esm|cjs   Output format (default: esm)\n');
            ctx.stdout.write('  --platform=browser|node  Target platform\n');
            ctx.stdout.write('  --minify           Minify output\n');
            ctx.stdout.write('  --sourcemap        Generate source maps\n');
            ctx.stdout.write('  --target=<target>  JS target (default: esnext)\n');
            ctx.stdout.write('  --loader=<loader>  Force file loader (ts, tsx, jsx, css)\n');
            ctx.stdout.write('  --version          Show version\n');
            ctx.stdout.write('\nPowered by esbuild-wasm (bundled in supervisor).\n');
            return 0;
        }
        // Lazy-init esbuild service
        if (!self.esbuildService) {
            self.ensureSqliteFs();
            self.esbuildService = new EsbuildService(kernelFs);
        }
        // Parse flags
        const flags = {};
        const entryPoints = [];
        for (const arg of args) {
            if (arg.startsWith('--')) {
                const eqIdx = arg.indexOf('=');
                if (eqIdx > 0) {
                    flags[arg.substring(2, eqIdx)] = arg.substring(eqIdx + 1);
                }
                else {
                    flags[arg.substring(2)] = 'true';
                }
            }
            else {
                entryPoints.push(arg);
            }
        }
        // Transform-only mode (single file, no --bundle)
        if (entryPoints.length === 1 && !flags['bundle']) {
            // Read the file and transform it
            const filePath = resolveVfsPath(entryPoints[0], ctx.cwd || '/home/user');
            let code;
            try {
                code = kernelFs.readFileString(filePath);
            }
            catch {
                ctx.stderr.write(`esbuild: could not read file: ${entryPoints[0]}\n`);
                return 1;
            }
            try {
                ctx.stderr.write('Transforming...\n');
                const result = await self.esbuildService.transform(code, {
                    loader: flags['loader'] || (() => {
                        const ext = filePath.split('.').pop()?.toLowerCase();
                        return { ts: 'ts', tsx: 'tsx', jsx: 'jsx', js: 'js', mts: 'ts', mjs: 'js', css: 'css', json: 'json' }[ext || ''];
                    })(),
                    format: flags['format'] || 'esm',
                    target: flags['target'] || 'esnext',
                    sourcemap: flags['sourcemap'] === 'true',
                    minify: flags['minify'] === 'true',
                });
                if (flags['outfile']) {
                    const outPath = resolveVfsPath(flags['outfile'], ctx.cwd || '/home/user');
                    const parent = parentVfsPath(outPath);
                    if (parent && !kernelFs.exists(parent))
                        kernelFs.mkdir(parent, { recursive: true });
                    kernelFs.writeFile(outPath, result.code);
                    ctx.stdout.write(`  ${outPath}  ${result.code.length} bytes\n`);
                }
                else {
                    ctx.stdout.write(result.code);
                }
                for (const w of result.warnings || []) {
                    ctx.stderr.write(`warning: ${w.text}\n`);
                }
                return 0;
            }
            catch (e) {
                ctx.stderr.write(`esbuild error: ${e?.message || e}\n`);
                return 1;
            }
        }
        // Bundle mode
        if (entryPoints.length === 0) {
            ctx.stderr.write('esbuild: no entry points specified\n');
            return 1;
        }
        // Resolve entry points relative to cwd
        const resolvedEntryPoints = entryPoints.map(ep => resolveVfsPath(ep, ctx.cwd || '/home/user'));
        try {
            ctx.stderr.write('Bundling...\n');
            const result = await self.esbuildService.build(resolvedEntryPoints, {
                bundle: flags['bundle'] === 'true',
                format: flags['format'] || 'esm',
                target: flags['target'] || 'esnext',
                platform: flags['platform'] || 'browser',
                outdir: flags['outfile'] ? undefined : (flags['outdir'] || '/dist'),
                outfile: flags['outfile'],
                sourcemap: flags['sourcemap'] === 'true',
                minify: flags['minify'] === 'true',
                external: flags['external']?.split(','),
            });
            for (const e of result.errors || []) {
                ctx.stderr.write(`error: ${e.text}\n`);
            }
            for (const w of result.warnings || []) {
                ctx.stderr.write(`warning: ${w.text}\n`);
            }
            if (result.errors?.length)
                return 1;
            // Write output files to VFS
            for (const f of result.outputFiles || []) {
                const outPath = normalizeVfsPath(f.path);
                const parent = parentVfsPath(outPath);
                if (parent && !kernelFs.exists(parent))
                    kernelFs.mkdir(parent, { recursive: true });
                kernelFs.writeFile(outPath, f.contents);
                ctx.stdout.write(`  ${outPath}  ${f.contents.length} bytes\n`);
            }
            ctx.stderr.write(`Done (${result.outputFiles?.length || 0} output files)\n`);
            return 0;
        }
        catch (e) {
            ctx.stderr.write(`esbuild error: ${e?.message || e}\n`);
            return 1;
        }
    });
    // ── vite command: start/stop the dev server ──────────────────────────
    registry.register('vite', createViteCommand(self));
    // ── nimbus-wrangler / wrangler command: Worker dev server ─────────────
    //
    // `wrangler` is registered as a transparent alias for `nimbus-wrangler`
    // so projects with `"dev": "wrangler dev"` in package.json Just Work.
    // The shared handler below takes an extra `invokedAs` flag so we can
    // - print a one-shot "DO-in-DO mode" banner on the first wrangler
    //   invocation per session (so users know they're getting a compat
    //   layer, not real wrangler)
    // - silently strip wrangler-specific flags (--ip, --port, etc.) that
    //   have no meaning inside a DO.
    const wranglerHandler = (invokedAs) => async (ctx) => {
        const rawArgs = ctx.args || [];
        // Filter wrangler-only flags early (works for both invocation paths;
        // a no-op for nimbus-wrangler since it doesn't accept them anyway).
        const { args, ignored } = filterWranglerFlags(rawArgs);
        if (args.includes('--help') || args.includes('-h') || args.length === 0) {
            ctx.stdout.write(`Usage: ${invokedAs} dev [options]\n\n`);
            ctx.stdout.write('Run your Cloudflare Worker locally on the actual CF runtime\n');
            ctx.stdout.write('(DO-in-DO via env.LOADER — workerd in a workerd).\n\n');
            ctx.stdout.write('Commands:\n');
            ctx.stdout.write('  dev           Start the dev server\n');
            ctx.stdout.write('  stop          Stop the dev server\n\n');
            ctx.stdout.write('Options:\n');
            ctx.stdout.write('  --root <dir>  Project root (default: cwd)\n\n');
            if (invokedAs === 'wrangler') {
                ctx.stdout.write('Note: \x1b[2minside Nimbus, `wrangler` is an alias for\x1b[0m \x1b[36mnimbus-wrangler\x1b[0m.\n');
                ctx.stdout.write('Most real-wrangler flags (--ip, --port, --local, --log-level, ...)\n');
                ctx.stdout.write('are silently ignored because the DO provides its own routing.\n');
            }
            return 0;
        }
        if (args[0] === 'stop') {
            if (self.nimbusWrangler?.isRunning) {
                self.nimbusWrangler.stop();
                ctx.stdout.write('\x1b[33mWorker dev server stopped.\x1b[0m\n');
            }
            else {
                ctx.stdout.write('No Worker dev server running.\n');
            }
            return 0;
        }
        if (args[0] !== 'dev') {
            ctx.stderr.write(`Unknown command: ${args[0]}. Use "${invokedAs} dev" or "${invokedAs} --help".\n`);
            return 1;
        }
        // First-run banner — only when invoked as `wrangler`, and only once
        // per session. Makes it OBVIOUS to the user that they're not running
        // real wrangler, and that Nimbus is doing something different.
        if (invokedAs === 'wrangler' && !self.wranglerAliasBannerShown) {
            ctx.stdout.write('\x1b[2m\u2388  wrangler (Nimbus DO-in-DO mode) — bundling via esbuild-wasm, running via env.LOADER\x1b[0m\n');
            self.wranglerAliasBannerShown = true;
        }
        // Report ignored flags (also one-shot — if user sees it once per
        // session that's enough to spot a typo; no need to spam on rebuilds).
        if (ignored.length > 0 && invokedAs === 'wrangler') {
            ctx.stdout.write('\x1b[2m   ignored wrangler flags: ' + ignored.join(' ') + '\x1b[0m\n');
        }
        // Lazy-init esbuild
        if (!self.esbuildService) {
            self.ensureSqliteFs();
            self.esbuildService = new EsbuildService(kernelFs);
        }
        // Parse --root flag; default to the shell cwd so `npm run dev` from
        // a project directory picks up that project's wrangler.jsonc.
        let root = ctx.cwd || '/home/user';
        for (let i = 1; i < args.length; i++) {
            if (args[i] === '--root' && args[i + 1])
                root = args[i + 1];
        }
        // Stop existing
        if (self.nimbusWrangler?.isRunning)
            self.nimbusWrangler.stop();
        const vfsRoot = resolveVfsPath(root, ctx.cwd || '/home/user');
        // Pre-flight: read the wrangler config ourselves and call out any
        // binding fields nimbus-wrangler can't provide. NimbusWrangler will
        // still try to bundle + load, but user sees up-front why their
        // Worker may fail when it tries to access a missing binding.
        const unsupportedFields = detectUnsupportedWranglerConfig(kernelFs, vfsRoot);
        ctx.stdout.write('\n');
        ctx.stdout.write('\x1b[1;35m  ' + (invokedAs === 'wrangler' ? 'Wrangler' : 'Nimbus Wrangler') + ' Dev\x1b[0m\n\n');
        if (unsupportedFields.length > 0) {
            ctx.stderr.write('\x1b[33m\u26A0\x1b[0m  \x1b[1mNimbus-incompatible wrangler.jsonc fields detected:\x1b[0m\n');
            for (const f of unsupportedFields) {
                ctx.stderr.write('   - \x1b[33m' + f + '\x1b[0m\n');
            }
            ctx.stderr.write('   These bindings are NOT provisioned inside nimbus-wrangler. Your Worker\n' +
                '   will get \x1b[2mundefined\x1b[0m when it tries to access them, which typically\n' +
                '   causes a runtime TypeError. The bundle will still build and load.\n' +
                '   \x1b[2mDeploy with real wrangler to get the real bindings.\x1b[0m\n\n');
        }
        self.nimbusWrangler = new NimbusWrangler({
            vfs: kernelFs,
            vfsEvents: sqliteFs.events,
            esbuild: self.esbuildService,
            env: self.env,
            // Supervisor DO ctx — required for ctx.facets.get() when
            // synthesizing durable_objects bindings on the inner Worker.
            ctx: self.ctx,
            root: vfsRoot,
            onLog: (msg) => {
                if (terminal) {
                    try {
                        terminal.write(msg);
                    }
                    catch { }
                }
            },
            onHmrMessage: (msg) => {
                if (terminal) {
                    try {
                        terminal.ws?.send(JSON.stringify({ type: 'hmr', data: msg }));
                    }
                    catch { }
                }
            },
        });
        const ok = await self.nimbusWrangler.start();
        if (!ok) {
            ctx.stderr.write('  \x1b[31mFailed to start Worker dev server.\x1b[0m\n');
            return 1;
        }
        const cfg = self.nimbusWrangler.stats;
        // runtime primitive support (P5): banner advertises the canonical
        // `/__nimbus/worker/` route. The legacy `/worker/` URL is still
        // accepted for one release (Sunset 2027-01-01) but new sessions
        // are pointed at the namespaced form.
        const workerBase = (self.sessionBasePath || '') + '/__nimbus/worker';
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Worker:   \x1b[36m' + workerBase + '/\x1b[0m\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Name:     ' + cfg.name + '\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Entry:    ' + cfg.main + '\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Root:     ' + cfg.root + '\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Reload:   on file change\n\n');
        ctx.stdout.write('  \x1b[2mRun \x1b[0m' + invokedAs + ' stop\x1b[2m to stop.\x1b[0m\n\n');
        return 0;
    };
    registry.register('nimbus-wrangler', wranglerHandler('nimbus-wrangler'));
    registry.register('wrangler', wranglerHandler('wrangler'));
    // ── npm-fast command: parallel npm install (v2 — batched writes) ────
    registry.register('npm-fast', async (ctx) => {
        const args = ctx.args || [];
        if (args.includes('--help') || args.includes('-h') || args.length === 0) {
            ctx.stdout.write('Usage: npm-fast install <packages...>\n\n');
            ctx.stdout.write('Nimbus npm v2 — batched VFS writes, content-addressed cache.\n');
            ctx.stdout.write('Handles 100+ dependency projects without crashing.\n');
            return 0;
        }
        if (args[0] !== 'install' && args[0] !== 'i') {
            ctx.stderr.write('Only "npm-fast install" is supported. Use "npm" for other commands.\n');
            return 1;
        }
        const packages = args.slice(1).filter((a) => !a.startsWith('-'));
        if (packages.length === 0) {
            ctx.stderr.write('Specify packages to install: npm-fast install react react-dom\n');
            return 1;
        }
        self.ensureSqliteFs();
        const cwd = normalizeVfsPath(ctx.cwd || '/home/user');
        // Ensure package.json exists
        const pkgJsonPath = cwd + '/package.json';
        if (!kernelFs.exists(pkgJsonPath)) {
            kernelFs.writeFile(pkgJsonPath, '{"name":"project","version":"1.0.0","dependencies":{}}\n');
        }
        ctx.stdout.write('\x1b[36mNimbus npm v2 (batched writes)\x1b[0m\n');
        await self.ensureNpmInstaller((msg) => {
            ctx.stdout.write('[npm] ' + msg + '\n');
        });
        const result = await self.npmInstaller.install(cwd, { packages, pid: ctx.pid, registry: ctx.env?.NPM_REGISTRY });
        if (result.failed.length > 0) {
            ctx.stderr.write('\x1b[31mFailed: ' + result.failed.join(', ') + '\x1b[0m\n');
        }
        // [HONEST INSTALL MESSAGE P0a] Yellow + "(N failed, see above)"
        // when partial. Green only when failed.length === 0. Pre-fix the
        // green line printed unconditionally — see user transcript line
        // 831 ("added 264 packages" with 353 silent failures above).
        const partial = result.failed.length > 0;
        const color = partial ? '\x1b[33m' : '\x1b[32m';
        const suffix = partial ? ` (${result.failed.length} failed, see above)` : '';
        ctx.stdout.write(`\n${color}added ${result.installed.length} packages (${result.totalFiles} files) in ${(result.elapsed / 1000).toFixed(1)}s${suffix}\x1b[0m\n`);
        if (result.cachedHits > 0) {
            ctx.stdout.write(`\x1b[2m  (${result.cachedHits} from cache)\x1b[0m\n`);
        }
        return result.failed.length > 0 ? 1 : 0;
    });
    HeredocHandler.install(shell, terminal);
    // ── Readline-parity keybindings (Ctrl+K, Ctrl+W, Alt+B, Alt+F, Alt+D,
    //    Ctrl+Y, Ctrl+T, Ctrl+L, Ctrl+R, Alt+. , Ctrl+←/→, Alt+←/→, Linux
    //    Home/End variants, Ctrl+B/F/N/P, …). Installed AFTER Heredoc so
    //    its handleInput wrapper takes precedence when heredoc mode is
    //    active. ──
    LineEditorExtender.install(shell, terminal);
    // ── Wire npm/npx with shellExecute ──
    const shellExecute = async (cmd, cmdCtx) => {
        const stdin = cmdCtx.stdin && cmdCtx.stdin !== cmdCtx.terminalStdin
            ? await cmdCtx.stdin.readAll()
            : undefined;
        const result = await shell.execute(cmd, {
            cwd: cmdCtx.cwd,
            env: cmdCtx.env,
            onStdout: textSink((d) => cmdCtx.stdout.write(d)),
            onStderr: textSink((d) => cmdCtx.stderr.write(d)),
            stdin,
            terminalStdin: cmdCtx.terminalStdin,
            // `npm run x` runs x on npm's own fds. Handing the nested execution a
            // sink without saying where that sink leads would make every fd look
            // redirected, and a runtime whose stdout is redirected stops streaming.
            terminalFds: {
                stdin: cmdCtx.isFdTerminal?.(0) ?? false,
                stdout: cmdCtx.isFdTerminal?.(1) ?? false,
                stderr: cmdCtx.isFdTerminal?.(2) ?? false,
            },
            commandContext: {
                pid: cmdCtx.pid,
                cred: cmdCtx.cred,
                setUmask: cmdCtx.setUmask,
            },
            runAs: runAsProcess,
        });
        return result.exitCode;
    };
    const shellEntrypointExecutor = {
        execute: async (cmd, options) => {
            const parentPid = options?.commandContext?.['pid'];
            if (typeof parentPid !== 'number') {
                throw new Error('shell entrypoint requires a parent process');
            }
            const childProcess = self.processes.spawn('sh', ['sh'], options?.cwd || '/home/user', { parentPid });
            let exitCode = 1;
            try {
                const identity = commandIdentityFor(childProcess.pid);
                const terminal = new HeadlessTerminal();
                const childShell = new Shell(terminal, workspace.filesystem, registry, { ...env, ...(options?.env || {}) }, processRegistry, identity);
                HeredocHandler.install(childShell, terminal);
                if (options?.cwd)
                    childShell.setCwd(options.cwd);
                const result = await childShell.execute(cmd, {
                    ...options,
                    commandContext: {
                        ...options?.commandContext,
                        pid: identity.pid,
                        cred: identity.cred,
                        setUmask: identity.setUmask,
                    },
                    runAs: runAsProcess,
                });
                exitCode = result.exitCode;
                return result;
            }
            finally {
                self.processes.exit(childProcess.pid, exitCode);
            }
        },
    };
    registerShellEntrypointCommands(registry, shellEntrypointExecutor);
    // Shell scripts that execute through the local shell still need the same
    // process-table and log-store contract as facet-backed processes.
    const shellExecuteTracked = async (cmd, cmdCtx, opts = {}) => {
        const entry = self.processes.spawn(cmd, [cmd], cmdCtx.cwd || '/home/user', { parentPid: cmdCtx.pid });
        const pid = entry.pid;
        if (opts.longRunning)
            self.processes.setLongRunning(pid);
        const startedAt = Date.now();
        // Spawn banner — matches facet-manager.ts onSpawn format.
        if (terminal) {
            const label = opts.longRunning ? 'started (long-running)' : 'started';
            terminal.write(`\x1b[2m[shell ${label}: pid=${pid} cmd="${cmd}"]\x1b[0m\r\n`);
        }
        // Structured spawn event for the tabs UI (mirrors the facet-manager
        // onSpawn hook). Long-running shell commands like `vite` and
        // `wrangler dev` trigger auto-open of a log tab.
        notifyTerminalEvent(terminal, {
            type: 'spawn', pid, command: cmd, longRunning: !!opts.longRunning, attachedTty: false,
        });
        // Wrap the caller-supplied streams so every chunk is both displayed
        // AND captured in the ring buffer keyed by this PID.
        const tee = (stream, target) => {
            const toTarget = textSink((text) => target.write(text));
            return (d) => {
                try {
                    self.processes.appendOutputBytes(pid, stream, d);
                }
                catch { }
                try {
                    toTarget(d);
                }
                catch { }
            };
        };
        let exitCode = 1;
        try {
            const result = await shell.execute(cmd, {
                cwd: cmdCtx.cwd,
                env: cmdCtx.env,
                onStdout: tee('stdout', cmdCtx.stdout),
                onStderr: tee('stderr', cmdCtx.stderr),
                // The tee is a sink, not a redirection: the script's fds are still
                // whatever the caller's were, and a runtime asks that question before
                // deciding whether it may stream past the shell.
                terminalFds: {
                    stdin: cmdCtx.isFdTerminal?.(0) ?? false,
                    stdout: cmdCtx.isFdTerminal?.(1) ?? false,
                    stderr: cmdCtx.isFdTerminal?.(2) ?? false,
                },
                // Single spawn path for long-running handoff: a registry command
                // (vite/wrangler/serve) ADOPTS this wrapper pid via the bin-spawn
                // contract instead of allocating a second one, and suppresses its
                // own `[started (long-running)]` notice.
                commandContext: {
                    pid,
                    cred: entry.cred,
                    setUmask: (mask) => self.processes.setUmask(pid, mask),
                    ...(opts.longRunning
                        ? {
                            __nimbusBinSpawn: {
                                skipSpawn: true,
                                callerPid: pid,
                                command: cmd,
                                forceLongRunning: true,
                            },
                        }
                        : {}),
                },
                runAs: runAsProcess,
            });
            exitCode = result.exitCode;
        }
        catch (e) {
            // Surface the error in the terminal and the ring buffer.
            const msg = (e && (e.stack || e.message)) || String(e);
            const line = 'shellExecuteTracked error: ' + msg + '\n';
            try {
                self.processes.appendOutput(pid, 'stderr', line);
            }
            catch { }
            try {
                cmdCtx.stderr.write(line);
            }
            catch { }
            exitCode = 1;
        }
        finally {
            // When a long-running script handed off to a live server (the registry
            // command adopted this pid and returned 0), the process stays running;
            // emitting an immediate exit would print a false `[shell exited]` and
            // flip the process to terminated in /api/processes. Mirror the npm-bin
            // resolver's `handedOffToLongRunningFacet` contract.
            const handedOffToLongRunningFacet = opts.longRunning === true && exitCode === 0;
            if (!handedOffToLongRunningFacet) {
                try {
                    self.processes.exit(pid, exitCode);
                }
                catch { }
                try {
                    if (!self.processes.getExit(pid)) {
                        self.processes.markExit(pid, exitCode);
                    }
                }
                catch { }
                // Structured exit for the tabs UI. Always fires (the UI doesn't
                // know which tabs are open, and client-side dedupe is trivial).
                // Include the command so the UI can backfill a tab for pids it
                // never saw a spawn event for (e.g. evals routed past onSpawn).
                notifyTerminalEvent(terminal, { type: 'exit', pid, code: exitCode, command: cmd });
                // Keep shell execution diagnostics on the same session helper used by
                // the rest of the process subsystem.
                try {
                    self._emitShellExecDone(pid, cmd, exitCode, Date.now() - startedAt);
                }
                catch { }
            }
        }
        return exitCode;
    };
    const runtimeCommandHint = createRuntimeCommandHintResolver(self.env);
    installNpmBinFallbackResolver(registry, {
        vfs: kernelFs,
        getCwd: () => shell?.cwd || '/home/user',
        processes: self.processes,
        getFacetManager: () => {
            self.ensureFacetManager();
            return facetMgr;
        },
        terminal: terminal,
        notifyTerminalEvent: (event) => notifyTerminalEvent(terminal, event),
        runtimeCommandHint,
        emitShellExecDone: (pid, command, exitCode, durationMs) => {
            try {
                self._emitShellExecDone(pid, command, exitCode, durationMs);
            }
            catch { }
        },
    });
    // Register core npm — the install work itself goes through the port,
    // which owns the NpmInstaller, prefix dirs and bin materialisation.
    const coreNpmCmd = createNpmCommand(registry, shellExecute, kernel, {
        installer: createNpmInstallPort(self),
    });
    registry.register('npm', async (ctx) => {
        const args = ctx.args || [];
        const sub = args[0];
        const cwdKey = normalizeVfsPath(ctx.cwd || '/home/user');
        // npm run <script> / npm test / npm start — parse package.json and execute
        if (sub === 'run' || sub === 'run-script' || sub === 'test' || sub === 'start') {
            const scriptName = sub === 'test' ? 'test' : sub === 'start' ? 'start' : args[1];
            if (!scriptName) {
                // npm run (no script) — list available scripts
                const pkgPath = cwdKey + '/package.json';
                try {
                    const pkg = JSON.parse(kernelFs.readFileString(pkgPath));
                    if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
                        ctx.stdout.write('Lifecycle scripts:\n');
                        for (const [name, cmd] of Object.entries(pkg.scripts)) {
                            ctx.stdout.write(`  ${name}\n    ${cmd}\n`);
                        }
                    }
                    else {
                        ctx.stdout.write('No scripts found in package.json\n');
                    }
                }
                catch {
                    ctx.stderr.write('npm ERR! no package.json found\n');
                    return 1;
                }
                return 0;
            }
            const pkgPath = cwdKey + '/package.json';
            try {
                const pkg = JSON.parse(kernelFs.readFileString(pkgPath));
                const script = pkg.scripts?.[scriptName];
                if (!script) {
                    ctx.stderr.write(`npm ERR! Missing script: "${scriptName}"\n`);
                    if (pkg.scripts) {
                        ctx.stderr.write('npm ERR! Available scripts:\n');
                        for (const name of Object.keys(pkg.scripts))
                            ctx.stderr.write(`  - ${name}\n`);
                    }
                    return 1;
                }
                // ── node_modules preflight ────────────────────────────────────
                // If the script invokes a known bundler/framework CLI (vite, next,
                // webpack, tsc, ...) and node_modules is missing, HARD-FAIL before
                // running it — the tool would crash with a cryptic "command not
                // found" / "cannot find package" error that's less helpful.
                // For custom/unknown scripts (e.g. `echo hi`), emit a warning but
                // continue — the user's intent might not need deps at all.
                // Bypass with --force / --no-install-check in the script args, or
                // by setting NIMBUS_SKIP_INSTALL_CHECK=1 in env.
                const scriptArgs = args.slice(sub === 'run' || sub === 'run-script' ? 2 : 1);
                const bypassRunCheck = scriptArgs.includes('--force') ||
                    scriptArgs.includes('--no-install-check') ||
                    ctx.env?.NIMBUS_SKIP_INSTALL_CHECK === '1';
                if (!bypassRunCheck) {
                    const guard = checkNodeModulesGuard(kernelFs, cwdKey);
                    if (guard.missing) {
                        const bundler = detectBundlerBin(script);
                        if (bundler) {
                            // Hard fail: script needs a bundler binary that lives in node_modules/.bin.
                            ctx.stderr.write('\x1b[31m\u2718\x1b[0m \x1b[1mnode_modules/ not found\x1b[0m — ' +
                                `script "${scriptName}" runs \x1b[36m${bundler}\x1b[0m which needs installed dependencies ` +
                                `(${guard.depCount} declared).\n` +
                                '  Run \x1b[36mnpm install\x1b[0m first,\n' +
                                '  or re-run with \x1b[36mnpm run ' + scriptName + ' -- --force\x1b[0m to skip this check.\n');
                            return 1;
                        }
                        // Soft warning: script might not need deps; let it try.
                        ctx.stderr.write('\x1b[33m\u26A0\x1b[0m  node_modules/ not found (' + guard.depCount + ' deps declared) — ' +
                            'proceeding anyway. Run \x1b[36mnpm install\x1b[0m if the script fails.\n\n');
                    }
                }
                ctx.stdout.write(`\n> ${pkg.name || 'project'}@${pkg.version || '1.0.0'} ${scriptName}\n`);
                ctx.stdout.write(`> ${script}\n\n`);
                // ── Next.js loud-block (was W11 per-framework substrate) ──────
                //
                // runtime primitive support (P12): the previous wave shipped this as a
                // 45-line standalone module at src/frameworks/next.ts that
                // exported nothing but the strings used here. Per the
                // "no per-framework substrate" rule, the message is inlined
                // (the only thing the module did was hold these strings) and
                // the file is deleted.
                //
                // Next.js dev/start/build/export all need the same pipeline —
                // custom http.Server + child_process.fork with v8-IPC +
                // webpack/Turbopack — none of which Nimbus ships. We surface a
                // deterministic refusal rather than letting the script hang or
                // (build) reset the isolate during spawn. The block remains a
                // one-off symbol-detection guard, NOT a generic per-framework
                // code path. Any future similar guard belongs alongside this
                // one — not in its own src/frameworks/<name>.ts file.
                const refused = refusedNextSubcommand(scriptName, script, pkg, scriptArgs);
                if (refused) {
                    ctx.stderr.write(NEXT_REFUSAL_MESSAGE);
                    return 127;
                }
                const scriptTrim = script.trim();
                const longRunning = scriptName === 'dev' || scriptName === 'start' ||
                    scriptName === 'serve' || scriptName === 'watch';
                return await shellExecuteTracked(scriptTrim, {
                    ...ctx,
                    env: { ...ctx.env, npm_lifecycle_event: scriptName, npm_package_name: pkg.name || '' },
                }, { longRunning });
            }
            catch (e) {
                ctx.stderr.write(`npm ERR! ${e?.message || e}\n`);
                return 1;
            }
        }
        // npm ls — list installed packages
        if (sub === 'ls' || sub === 'list') {
            const pkgPath = cwdKey + '/package.json';
            const nmDir = cwdKey + '/node_modules';
            try {
                const pkg = JSON.parse(kernelFs.readFileString(pkgPath));
                ctx.stdout.write(`${pkg.name || 'project'}@${pkg.version || '1.0.0'} ${ctx.cwd}\n`);
                const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
                const names = Object.keys(deps);
                for (let i = 0; i < names.length; i++) {
                    const isLast = i === names.length - 1;
                    const prefix = isLast ? '└── ' : '├── ';
                    const name = names[i];
                    let version = deps[name];
                    // Try to read actual installed version
                    try {
                        const installed = JSON.parse(kernelFs.readFileString(nmDir + '/' + name + '/package.json'));
                        version = installed.version;
                    }
                    catch { }
                    ctx.stdout.write(`${prefix}${name}@${version}\n`);
                }
            }
            catch {
                ctx.stderr.write('npm ERR! no package.json found\n');
                return 1;
            }
            return 0;
        }
        // npm init / npm init -y
        if (sub === 'init') {
            const cwd = cwdKey;
            const pkgPath = cwd + '/package.json';
            if (kernelFs.exists(pkgPath) && !args.includes('-y') && !args.includes('--yes')) {
                ctx.stderr.write('package.json already exists. Use -y to overwrite.\n');
                return 1;
            }
            const name = cwd.split('/').pop() || 'project';
            const pkg = {
                name, version: '1.0.0', description: '', main: 'index.js',
                type: 'module',
                scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview', test: 'echo "no test"' },
                keywords: [], author: '', license: 'MIT', dependencies: {}, devDependencies: {},
            };
            kernelFs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
            ctx.stdout.write('Wrote to ' + pkgPath + '\n');
            return 0;
        }
        // npm uninstall <pkg>
        if (sub === 'uninstall' || sub === 'un' || sub === 'remove' || sub === 'rm') {
            const packages = args.slice(1).filter(a => !a.startsWith('-'));
            if (packages.length === 0) {
                ctx.stderr.write('Usage: npm uninstall <pkg>\n');
                return 1;
            }
            const nmDir = cwdKey + '/node_modules';
            for (const pkg of packages) {
                const pkgDir = nmDir + '/' + pkg;
                // Recursively delete package directory
                const deleteRecursive = (dir) => {
                    try {
                        for (const e of kernelFs.readdir(dir)) {
                            const fp = dir + '/' + e.name;
                            if (e.type === 'directory')
                                deleteRecursive(fp);
                            else
                                try {
                                    kernelFs.unlink(fp);
                                }
                                catch { }
                        }
                        try {
                            kernelFs.rmdir(dir);
                        }
                        catch { }
                    }
                    catch { }
                };
                deleteRecursive(pkgDir);
                ctx.stdout.write('removed ' + pkg + '\n');
            }
            // Update package.json
            const pkgPath = cwdKey + '/package.json';
            try {
                const pkgJson = JSON.parse(kernelFs.readFileString(pkgPath));
                for (const pkg of packages) {
                    delete pkgJson.dependencies?.[pkg];
                    delete pkgJson.devDependencies?.[pkg];
                }
                kernelFs.writeFile(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n');
            }
            catch { }
            return 0;
        }
        // ── npm create <pkg> / npm init <pkg> → npx create-<pkg> ─────────
        //
        // Per the npm spec, `npm create X args...` and `npm init X args...`
        // (when X is supplied) are sugar for invoking the `create-X`
        // initializer package via npx. Specifically:
        //
        //   npm create foo args...           → npx create-foo args...
        //   npm create foo@1.2 args...       → npx create-foo@1.2 args...
        //   npm create @scope/foo args...    → npx @scope/create-foo args...
        //   npm create @scope args...        → npx @scope/create args...
        //
        // `npm init` (no args) is a different beast — it scaffolds a
        // package.json interactively. The `sub === 'init'` branch above
        // handles the no-arg case; here we only intercept the
        // initializer-package case (1+ args after `init`).
        //
        // Without this routing, `npm create vite@latest mvp -- --template
        // react-ts` hits the base npm dispatch which only knows
        // {init, install/i/add, uninstall/remove/rm/un, list/ls,
        // run/run-script, start, test, info/view/show, search, version}
        // — and emits "npm: unknown command 'create'". Every modern
        // framework's `create-*` flow (create-vite, create-next-app
        // routed via "npm create", create-cloudflare, create-astro, etc.)
        // depends on this.
        //
        // This is a primitive: one fix, every framework wins.
        if (sub === 'create' || (sub === 'init' && args.length >= 2 && !args[1].startsWith('-'))) {
            const arg1 = args[1];
            if (!arg1) {
                ctx.stderr.write('npm create: missing package name\n');
                ctx.stderr.write('Usage: npm create <pkg> [args...]\n');
                return 1;
            }
            // Parse pkg + version. Scope-aware:
            //   @scope        → @scope/create
            //   @scope/foo    → @scope/create-foo
            //   foo           → create-foo
            //   foo@1.2.3     → create-foo@1.2.3
            //   foo@latest    → create-foo@latest
            function rewriteToCreatePkg(spec) {
                // Strip an optional version range and re-append after the rewrite.
                const atIdx = spec.lastIndexOf('@');
                const hasVersion = atIdx > 0; // a leading @ is the scope; not a version
                const bare = hasVersion ? spec.slice(0, atIdx) : spec;
                const version = hasVersion ? spec.slice(atIdx) : '';
                let pkg;
                if (bare.startsWith('@')) {
                    const slash = bare.indexOf('/');
                    if (slash < 0) {
                        // @scope → @scope/create
                        pkg = bare + '/create';
                    }
                    else {
                        // @scope/foo → @scope/create-foo
                        const scope = bare.slice(0, slash);
                        const name = bare.slice(slash + 1);
                        pkg = scope + '/create-' + name;
                    }
                }
                else {
                    pkg = 'create-' + bare;
                }
                return pkg + version;
            }
            const createPkg = rewriteToCreatePkg(arg1);
            const passThrough = args.slice(2);
            // `npm create` accepts an optional `--` separator to push the
            // remaining args to the create script; npx doesn't need a
            // separator (positional args after the package name go to the
            // package). We strip a single literal `--` token if present so
            // `npm create vite@latest mvp -- --template react-ts` becomes
            // `npx --yes create-vite@latest mvp --template react-ts`.
            const stripped = passThrough.filter((a, i, arr) => !(a === '--' && i < arr.length - 1) && !(a === '--' && arr.indexOf('--') === i));
            // Inform the user what we're routing to — matches npm's own
            // visible "npx" line so the create flow is honest.
            ctx.stdout.write(`> npx --yes ${createPkg}${stripped.length ? ' ' + stripped.join(' ') : ''}\n`);
            // Dispatch through the npx registry entry. `--yes` skips the
            // "Ok to proceed? (y)" prompt.
            const npxHandler = await registry.resolve('npx');
            if (!npxHandler) {
                ctx.stderr.write('npm create: npx command unavailable\n');
                return 1;
            }
            return await npxHandler({
                ...ctx,
                args: ['--yes', createPkg, ...stripped],
            });
        }
        // Fall through to core npm for other subcommands
        return coreNpmCmd(ctx);
    });
    // npx: check registered commands first, then resolve/install through
    // Nimbus's NpmInstaller and execute the package bin via the Node runtime.
    registry.register('npx', async (ctx) => {
        const npxArgs = ctx.args || [];
        const { describeNpxSelfInvocation, formatNpxHelp, getNpxCommandArgs, getNpxCommandWord, resolveNpxBinary, } = await import('../npm/npx-install.js');
        const selfInvocation = describeNpxSelfInvocation(npxArgs);
        if (selfInvocation === 'missing') {
            ctx.stderr.write('Usage: npx <command> [args...]\n');
            return 1;
        }
        if (selfInvocation === 'version') {
            ctx.stdout.write(NPM_VERSION + '\n');
            return 0;
        }
        if (selfInvocation === 'help') {
            ctx.stdout.write(formatNpxHelp());
            return 0;
        }
        const cmd = getNpxCommandWord(npxArgs);
        // Check if it's a built-in command (vite, esbuild, etc.)
        const resolved = cmd ? await registry.resolve(cmd) : null;
        if (resolved) {
            return await resolved({ ...ctx, args: getNpxCommandArgs(npxArgs) });
        }
        // Nimbus-native npx install + run path. Routes package installation
        // through NpmInstaller's full-packument resolver.
        await self.ensureNpmInstaller((msg) => ctx.stdout.write('[npm] ' + msg + '\n'));
        self.ensureSqliteFs();
        const installer = self.npmInstaller;
        const resolveResult = await resolveNpxBinary(installer, sqliteFs.as(requireVfsCred(ctx.cred, 'npx')), ctx.cwd || '/home/user', npxArgs, (msg) => ctx.stdout.write(msg + '\n'), ctx.pid, ctx.env?.NPM_REGISTRY);
        if (resolveResult.ok && resolveResult.binPath) {
            const nodeCmd = await registry.resolve('node');
            if (nodeCmd) {
                return await nodeCmd({
                    ...ctx,
                    args: [resolveResult.binPath, ...(resolveResult.binArgs || [])],
                    __nimbusBundleProfile: resolveResult.bundleProfile,
                });
            }
            ctx.stderr.write('npx: node runtime is not registered\n');
            return 1;
        }
        ctx.stderr.write((resolveResult.error || 'npx: could not resolve binary') + '\n');
        return 1;
    });
    // ── Register process commands (enhanced with facet process tracking) ──
    registry.register('ps', async (ctx) => {
        // Pids are generation-strided (see PID_GEN_STRIDE) so they can be 7+
        // digits; size the column to the widest pid in this listing.
        const procs = self.processes.getAll();
        const pidWidth = Math.max(3, ...procs.map((p) => String(p.pid).length));
        ctx.stdout.write(`  ${'PID'.padStart(pidWidth)}  STATUS              COMMAND\n`);
        for (const proc of procs) {
            // Prefer log-store exit info over ProcessTable's: the store has
            // the authoritative code and survives reap. For `running`, rely
            // on ProcessTable (store has no "running" concept).
            let status;
            if (proc.state === 'running') {
                status = '\x1b[32mrunning\x1b[0m';
            }
            else if (proc.state === 'killed') {
                status = `\x1b[33mkilled(${proc.exitCode ?? 137})\x1b[0m`;
            }
            else {
                // 'exited' — distinguish clean vs crashed.
                const code = proc.exitCode ?? 0;
                status = code === 0
                    ? `\x1b[2mexited(0)\x1b[0m`
                    : `\x1b[31mcrashed(${code})\x1b[0m`;
            }
            ctx.stdout.write(`  ${String(proc.pid).padStart(pidWidth)}  ${status.padEnd(26)}  ${proc.command}\n`);
        }
        // Show vite dev server
        if (self.viteDevServer?.isRunning) {
            ctx.stdout.write(`  \x1b[33m${'---'.padStart(pidWidth)}\x1b[0m  \x1b[32mrunning\x1b[0m                     vite dev server (${self.viteBasePath}/)\n`);
        }
        if (self.processes.getAll().length === 0 && !self.viteDevServer?.isRunning) {
            ctx.stdout.write('  (no processes)\n');
        }
        return 0;
    });
    // ── `logs <pid>` — tail per-process ring buffer ──
    // Flags:
    //   -f / --follow     stream new chunks until the process exits
    //   -n / --lines N    number of lines from the tail (default 200)
    //   --bytes N         max bytes from the tail (overrides --lines)
    //   --plain           strip ANSI escapes on output (keeps buffer raw)
    registry.register('logs', async (ctx) => {
        const args = ctx.args || [];
        const follow = args.includes('-f') || args.includes('--follow');
        const plain = args.includes('--plain');
        let lines = 200;
        let bytes;
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if ((a === '-n' || a === '--lines') && args[i + 1]) {
                const n = parseInt(args[i + 1], 10);
                if (!isNaN(n) && n > 0)
                    lines = n;
                i++;
            }
            else if (a === '--bytes' && args[i + 1]) {
                const n = parseInt(args[i + 1], 10);
                if (!isNaN(n) && n > 0)
                    bytes = n;
                i++;
            }
        }
        const pidArg = args.find(a => /^\d+$/.test(a));
        if (!pidArg) {
            ctx.stderr.write('usage: logs [-f] [-n LINES | --bytes N] [--plain] <pid>\n');
            return 1;
        }
        const pid = parseInt(pidArg, 10);
        if (!self.processes.hasLogs(pid)) {
            ctx.stderr.write(`no logs for pid ${pid}\n`);
            return 1;
        }
        // Paint a single chunk for live-stream (follow-mode) rendering.
        // `--plain` strips ANSI per chunk — safe for live output because
        // individual streamed chunks from the RPC layer never split an
        // escape sequence (the RPC boundary always delivers a complete
        // write call). Backfill is different (see below).
        const renderChunk = (c) => {
            let data = c.data;
            if (plain)
                data = stripAnsi(data);
            if (c.stream === 'stderr' && !plain) {
                return `\x1b[31m${data}\x1b[0m`;
            }
            return data;
        };
        // Backfill. Concatenate same-stream consecutive chunks BEFORE
        // stripping so that any ANSI escape split across chunk boundaries
        // (by the 4 KB splitter inside ProcessLogStore) gets rejoined and
        // stripped cleanly instead of leaking `1m` / `[31m` fragments.
        const tailOpts = bytes !== undefined ? { bytes } : { lines };
        const chunks = self.processes.tailLogs(pid, tailOpts);
        let group = [];
        const flushGroup = () => {
            if (group.length === 0)
                return;
            const stream = group[0].stream;
            let data = group.map(c => c.data).join('');
            if (plain)
                data = stripAnsi(data);
            if (stream === 'stderr' && !plain) {
                ctx.stdout.write(`\x1b[31m${data}\x1b[0m`);
            }
            else {
                ctx.stdout.write(data);
            }
            group = [];
        };
        for (const c of chunks) {
            if (group.length > 0 && group[group.length - 1].stream !== c.stream) {
                flushGroup();
            }
            group.push(c);
        }
        flushGroup();
        if (!follow) {
            // Footer only when process has exited already.
            const exit = self.processes.getExit(pid);
            if (exit) {
                ctx.stdout.write(`\r\n\x1b[2m[process exited with code ${exit.code}${exit.reason ? ` (${exit.reason})` : ''}]\x1b[0m\r\n`);
            }
            return 0;
        }
        // Follow mode: subscribe to live appends, poll for exit.
        const entry = self.processes.get(pid);
        const alreadyExited = !entry || entry.state !== 'running' || self.processes.getExit(pid);
        if (alreadyExited) {
            const exit = self.processes.getExit(pid);
            if (exit) {
                ctx.stdout.write(`\r\n\x1b[2m[process exited with code ${exit.code}${exit.reason ? ` (${exit.reason})` : ''}]\x1b[0m\r\n`);
            }
            return 0;
        }
        return await new Promise((resolve) => {
            let done = false;
            const finish = (code) => {
                if (done)
                    return;
                done = true;
                unsub();
                unsubExit();
                resolve(code);
            };
            const unsub = self.processes.subscribeLogs(pid, (c) => {
                ctx.stdout.write(renderChunk(c));
            });
            const unsubExit = self.processes.subscribeExit(pid, (exit) => {
                ctx.stdout.write(`\r\n\x1b[2m[process exited with code ${exit.code}${exit.reason ? ` (${exit.reason})` : ''}]\x1b[0m\r\n`);
                finish(0);
            });
            // TOCTOU: the process may have exited between our `alreadyExited`
            // check above and these subscribe calls. Re-check now that the
            // exit subscriber is wired — if exit already set, the subscribe
            // callback never fires, so synthesize the footer ourselves.
            const exitNow = self.processes.getExit(pid);
            if (exitNow) {
                ctx.stdout.write(`\r\n\x1b[2m[process exited with code ${exitNow.code}${exitNow.reason ? ` (${exitNow.reason})` : ''}]\x1b[0m\r\n`);
                finish(0);
                return;
            }
            // If ctx exposes an AbortSignal (Ctrl+C wired by the shell),
            // honor it. Otherwise, follow-mode ends only on process exit.
            if (ctx.signal && typeof ctx.signal.addEventListener === 'function') {
                ctx.signal.addEventListener('abort', () => finish(130));
            }
        });
    });
    registry.register('jobs', async (ctx) => {
        const running = self.processes.getRunning();
        if (running.length === 0 && !self.viteDevServer?.isRunning) {
            ctx.stdout.write('No background jobs.\n');
            return 0;
        }
        for (let i = 0; i < running.length; i++) {
            ctx.stdout.write(`[${i + 1}]  Running    ${running[i].command} (pid ${running[i].pid})\n`);
        }
        if (self.viteDevServer?.isRunning) {
            ctx.stdout.write(`[${running.length + 1}]  Running    vite dev server\n`);
        }
        return 0;
    });
    const shellKillCommand = createKillCommand(processRegistry);
    registry.register('kill', async (ctx) => {
        const pidArg = ctx.args[0];
        if (!pidArg) {
            ctx.stderr.write('Usage: kill <pid>\n');
            return 1;
        }
        if (pidArg.startsWith('-') || pidArg.startsWith('%')) {
            return shellKillCommand(ctx);
        }
        const pid = parseInt(pidArg);
        if (isNaN(pid)) {
            ctx.stderr.write('kill: invalid pid\n');
            return 1;
        }
        if (processRegistry.get(pid)) {
            return shellKillCommand(ctx);
        }
        // runtime primitive support (P11): if the target is the vite shim PID
        // (registered by P5's long-running spawn), tear down the
        // in-process viteDevServer / cirrusReal too — facetManager.kill
        // only handles real Worker-Loader facets, and would leave the
        // shim running with its port registered against a dead PID.
        if (self._viteShimPid === pid) {
            try {
                if (self.cirrusReal?.isRunning) {
                    self.cirrusReal.stop(self.ctx);
                    self.cirrusReal = null;
                }
                if (self.viteDevServer?.isRunning) {
                    self.viteDevServer.stop();
                    self.viteDevServer = null;
                    try {
                        await self.ctx.storage.delete(VITE_CONFIG_KEY);
                    }
                    catch { }
                }
            }
            catch (e) {
                ctx.stderr.write('kill: while stopping vite shim: ' + (e?.message || e) + '\n');
            }
            try {
                self.portRegistry.unregisterByPid(pid);
            }
            catch { }
            try {
                self.processes.kill(pid);
            }
            catch { }
            notifyTerminalEvent(terminal, {
                type: 'exit', pid, code: 137, command: 'vite',
            });
            self._viteShimPid = null;
            self._viteShimPort = null;
            ctx.stdout.write(`Process ${pid} killed.\n`);
            return 0;
        }
        if (facetMgr?.kill(pid)) {
            ctx.stdout.write(`Process ${pid} killed.\n`);
            return 0;
        }
        ctx.stderr.write(`kill: no such process: ${pid}\n`);
        return 1;
    });
    registry.register('top', createTopCommand(processRegistry));
    registry.register('watch', createWatchCommand(registry));
    registry.register('help', createHelpCommand(registry));
    // ── Rehydrate globally-installed npm packages ──
    try {
        rehydrateGlobalPackages(kernel.vfs, registry);
    }
    catch { }
}
