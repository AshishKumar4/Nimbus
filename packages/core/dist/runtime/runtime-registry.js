/**
 * runtime-registry.ts — shared shell-command factory for runtime
 * dispatchers (node, bun, and future native-WASM / Python / Ruby /
 * AssemblyScript runtimes).
 *
 * Why this exists
 * ───────────────
 * `node` and `bun` shell-command handlers in src/session/init.ts
 * shared ~85% of their code: argv parsing for --version / --help /
 * -e / script-path, VFS lookup, shebang strip, esbuild transform for
 * .ts/.tsx/.jsx, dispatch to the runner. The duplication had drifted
 * — only `node` had the primitive #1 nodeFlagSpan fix
 * (init.ts:233-243), only `node` had primitive-#2 binSpawn ctx
 * propagation (init.ts:391-403), only `bun` had install / run
 * subcommand routing.
 *
 * `buildRuntimeHandler` returns a single shell-handler function that
 * encodes the shared contract. Per-runtime variation is supplied
 * via the `RuntimeSpec` parameter:
 *
 *   - name + version + helpText
 *   - run(): runner fn (runFresh / runBunScript / wasm-runner)
 *   - subcommands: optional map of `<verb> → handler` for
 *     bun-style `bun install`, `bun run` (node has none today)
 *   - transform(): optional code rewriter (bun prepends BUN_SHIM_PREAMBLE)
 *   - supportsBinSpawn: true for node and bun (a .bin handler, the
 *     child_process broker or a background job propagates a callerPid);
 *     other runtimes use a plain spawn flow.
 *
 * Anti-requirements observed
 * ──────────────────────────
 *   - NO setTimeout / NO retry / NO defensive-catch added.
 *   - NO behavioral change vs the pre-refactor handlers — every
 *     runtime-specific quirk is preserved exactly.
 *   - Per-runtime test parity: existing runtime-primitives probes
 *     (#1 npx / #2 .bin) and runtime-pkg probes (G1-G4) MUST still
 *     pass against the refactored handlers — the contract is
 *     observable behaviour, not implementation shape.
 */
import { normalizeVfsPath, resolveVfsPath, vfsPathExtension } from '../vfs/path.js';
import { typescriptLoader } from '../_shared/typescript-specifiers.js';
import { parseFacetBundleProfile } from './bundle-profile.js';
import { errorText } from '../_shared/error-text.js';
import { isEsModuleFile, isEsModuleInput } from './module-format.js';
import { packageScopeType } from './require-resolution.js';
import { isDirectory } from '../vfs/vfs.js';
import { programLaunchesServer, SERVER_LAUNCH_MODULE_BYTES } from './server-launch.js';
/**
 * The nearest directory at or above `dir` that holds a package.json, or null.
 * The first one wins (Node's rule); the filesystem root is not a package.
 */
async function nearestPackageDir(fs, dir) {
    for (let at = normalizeVfsPath(dir); at !== ''; at = at.slice(0, Math.max(0, at.lastIndexOf('/')))) {
        if (await fs.exists(`${at}/package.json`))
            return at;
    }
    return null;
}
/** Extensions probed when a target names no exact file, in Node's order. */
const SCRIPT_RESOLUTION_CANDIDATES = ['.js', '.ts', '.tsx', '.mjs', '.jsx', '/index.js', '/index.ts'];
/**
 * Resolve a runtime target — `./cli.ts`, `sub/x`, `.`, or a bare name — to a
 * canonical VFS key, or null when nothing runnable sits there.
 *
 * A directory never resolves to itself: it falls through to the index
 * candidates, so `bun ./tools` finds `tools/index.js` the way real bun does
 * rather than trying to read the directory as source.
 */
export async function resolveRuntimeScriptPath(fs, cwd, target, opts) {
    const base = normalizeVfsPath(cwd || '/home/user');
    let resolved;
    if (target === '.' || target === './') {
        // `node .` / `bun .` — the package's declared entry point.
        let main = 'index.js';
        try {
            const pkg = JSON.parse(await fs.readFileString(`${base}/package.json`));
            main = (opts?.preferModuleField ? pkg.module : undefined) || pkg.main || 'index.js';
        }
        catch { /* no readable package.json — index.js */ }
        resolved = resolveVfsPath(main, base);
    }
    else {
        resolved = resolveVfsPath(target, base);
    }
    if (await fs.isFile(resolved))
        return resolved;
    for (const candidate of SCRIPT_RESOLUTION_CANDIDATES) {
        if (await fs.isFile(resolved + candidate))
            return resolved + candidate;
    }
    return null;
}
/**
 * Build a shell-handler function for a runtime. The returned function
 * is the value passed to `registry.register('<name>', handler)`.
 *
 * Captures `getEsbuild` (for lazy init) + the spec. The same factory is used for every runtime; the only
 * runtime-specific code lives in `spec`.
 */
export function buildRuntimeHandler(spec, ctx0) {
    const { getEsbuild, registry } = ctx0;
    /**
     * The standard invocation: flag span, --version/--help/-e, then the
     * script-path flow. Subcommand verbs are NOT considered here — the
     * caller has already consumed them — so a verb handler can delegate
     * back in with a rewritten argv without re-triggering itself.
     */
    async function runtimeInvocation(ctx, args) {
        const fs = ctx.vfs;
        const name = spec.name;
        const nimbusCtx = ctx;
        // A facet-hosted runtime streams its output to the session terminal over
        // the supervisor RPC and hands the shell an empty string. That is live and
        // cheap, and it is only correct while the process's stdout IS the terminal:
        // the stream bypasses the shell's stdout chain, so the moment fd 1 or fd 2
        // is a file, a pipe, a command substitution, or the capture sink of a
        // programmatic exec, the bytes have to come back in the result and be
        // written through ctx.stdout instead. A context with no fd table of its own
        // — the child_process broker synthesizes one — says so directly, and that
        // wins: a broker child's fds are pipes, and its live output reaches the
        // parent through them (the broker routes a child pid's output to its queue).
        const captureOutput = typeof nimbusCtx.__nimbusCaptureOutput === 'boolean'
            ? nimbusCtx.__nimbusCaptureOutput
            : ctx.isFdTerminal?.(1) === false || ctx.isFdTerminal?.(2) === false;
        // A bin wrapper or child-process broker may already own the process
        // entry; preserve it for eval/stdin programs as well as script files.
        const binSpawn = spec.supportsBinSpawn ? nimbusCtx.__nimbusBinSpawn : undefined;
        // fd 0 the same way: a pipe or redirect is the program's stdin. It used
        // to be dropped, so `echo hi | node x.js` read nothing. A process whose
        // live input channel already is that stdin reads the channel.
        const pipedStdin = binSpawn?.liveInput !== true && ctx.stdin && ctx.stdin !== ctx.terminalStdin && ctx.isFdTerminal?.(0) === false
            ? ctx.stdin : undefined;
        const reservedProcess = binSpawn ? {
            skipSpawn: true, callerPid: binSpawn.callerPid,
            forceLongRunning: binSpawn.forceLongRunning === true, attachedTty: binSpawn.attachedTty === true,
            ...(binSpawn.stdinWriter === true ? { stdinWriter: true } : {}),
        } : {};
        const bundleProfile = parseFacetBundleProfile(nimbusCtx.__nimbusBundleProfile);
        const moduleScope = spec.moduleScope ?? 'node';
        // How the analyses of a program's code read its modules: the command's
        // own view of the filesystem.
        const programHost = {
            resolve: (from, specifier) => resolveRuntimeScriptPath(fs, from, specifier),
            read: async (path) => {
                try {
                    // Past the bound it is not walked, so it is not read either.
                    if (((await fs.stat(path))?.size ?? 0) > SERVER_LAUNCH_MODULE_BYTES)
                        return null;
                    return await fs.readFileString(path);
                }
                catch {
                    return null;
                }
            },
        };
        // Whether the program starts a server, so the runner can give it a
        // resident process; a .bin wrapper has already decided that by its own rule.
        const launches = async (code, path, dir, programArgs) => {
            if (spec.routesServers !== true || binSpawn !== undefined)
                return false;
            const key = normalizeVfsPath(dir);
            return programLaunchesServer({
                source: code,
                path,
                dir: key,
                packageRoot: (await nearestPackageDir(fs, key)) ?? key,
                argv: [name, ...programArgs],
            }, programHost);
        };
        // The program's piped stdin: a pipe streams to it as it arrives, and a
        // `< file` is the file itself, nothing read from its stream here. A
        // process whose own channel is its stdin (a child_process child's) reads
        // that channel itself. Nothing is read ahead for the program: a
        // synchronous read that needs more than has arrived waits for it in the
        // runner, which stops the run and runs it again once the input is there
        // (worker runtime/stop-replay.ts).
        const programStdin = pipedStdin === undefined ? {}
            : pipedStdin.file
                ? { stdinFile: { path: pipedStdin.file.path, offset: pipedStdin.file.offset } }
                : { stdin: pipedStdin };
        /**
         * Run `code` as this invocation's program, whichever way the arguments
         * named it (-e, the REPL, stdin, a file): what the program is (its argv,
         * file, command line, stdin) with what every mode shares, and its output
         * written through. `reserved` is false where the runner keeps no process
         * a bin wrapper reserved (wasm-runner's).
         */
        const runProgram = async (code, program) => {
            const result = await spec.run(code, {
                cred: ctx.cred,
                invokerPid: ctx.pid,
                signal: ctx.signal,
                argv: program.argv,
                env: ctx.env,
                cwd: ctx.cwd,
                filename: program.filename,
                dirname: program.dirname,
                command: program.command,
                ...program.stdin,
                ...(program.reserved === false ? {} : reservedProcess),
                ...(captureOutput ? { captureOutput: true } : {}),
                ...(bundleProfile ? { bundleProfile } : {}),
                ...(program.launchesServer ? { launchesServer: true } : {}),
                // Evaluated as Node's loader runs an ES module, in Node's scope.
                ...(program.esModule && moduleScope === 'node' ? { esModule: true } : {}),
                moduleScope,
            });
            if (result.stdout)
                ctx.stdout.write(result.stdout);
            if (result.stderr)
                ctx.stderr.write(result.stderr);
            return result.exitCode;
        };
        // ── Flag-span computation (primitive #1) ──
        //
        // Real-Node only treats args UP TO the first non-flag token as
        // CLI flags. Pre-refactor, version/help/eval scanned the entire
        // args array, breaking `node /path/to/tsc --version` (the user's
        // --version was misinterpreted as a node flag).
        let flagSpan = 0;
        // A bare `-` is not a flag: it is the program itself, read from stdin
        // (`node - a b <<'EOF' ... EOF`, as installers pipe their helper scripts).
        while (flagSpan < args.length && args[flagSpan].startsWith('-') && args[flagSpan] !== '-') {
            flagSpan++;
            const prev = args[flagSpan - 1];
            // -e / --eval and a spaced --input-type consume one value; advance past it.
            if ((prev === '-e' || prev === '--eval' || prev === '--input-type') && flagSpan < args.length) {
                flagSpan++;
            }
        }
        const flagSlice = args.slice(0, flagSpan);
        // What `-e` code and a program read from stdin are: `--input-type=module`
        // or `--input-type module`, else Node's syntax detection (module-format.ts).
        const inputTypeAt = flagSlice.findIndex((arg) => arg === '--input-type' || arg.startsWith('--input-type='));
        const inputType = inputTypeAt === -1 ? undefined
            : flagSlice[inputTypeAt] === '--input-type' ? flagSlice[inputTypeAt + 1]
                : flagSlice[inputTypeAt].slice('--input-type='.length);
        /**
         * A program's source as the CommonJS a facet runs (core/_shared/commonjs-cell.ts):
         * TypeScript, JSX or an ES module (`esm`) compiled by esbuild, its import() calls kept
         * and routed to the process's ESM loader (dynamic-import-rewrite.ts), its
         * import.meta the module's own (url, resolve, dirname and filename, read
         * directly, as an object or destructured: the runner's __nimbusFileImportMeta;
         * CommonJS output alone would make it {}). Null when the transform failed,
         * which it has reported.
         */
        async function lowerToCommonJs(code, loader, url, what, esm) {
            try {
                const eb = await getEsbuild();
                // An ES module keeps Node's scope (module-format.ts ModuleScope): strict, no CommonJS wrapper name.
                return (await eb.transform(code, {
                    loader, format: 'cjs', dynamicImportParent: url, moduleMetadata: true, ...(esm && moduleScope === 'node' ? { esModuleScope: true } : {}),
                })).code;
            }
            catch (e) {
                ctx.stderr.write(`${name}: transform error for ${what}: ${errorText(e)}\n`);
                return null;
            }
        }
        /** The URL Node gives `-e` code and a program read from stdin: `[eval1]` in the working directory. */
        const evalUrl = () => 'file:///' + normalizeVfsPath((ctx.cwd || '/home/user') + '/[eval1]');
        // ── --version ──
        if (flagSlice.includes('-v') || flagSlice.includes('--version')) {
            ctx.stdout.write(spec.version + '\n');
            return 0;
        }
        // ── --help ──
        if (flagSlice.includes('--help') || flagSlice.includes('-h')) {
            ctx.stdout.write(spec.helpText);
            if (!spec.helpText.endsWith('\n'))
                ctx.stdout.write('\n');
            return 0;
        }
        // ── -e / --eval ──
        const evalIdx = flagSlice.indexOf('-e') !== -1
            ? flagSlice.indexOf('-e')
            : flagSlice.indexOf('--eval');
        if (evalIdx !== -1) {
            let code = args[evalIdx + 1];
            if (!code) {
                ctx.stderr.write(`${name}: -e requires an argument\n`);
                return 1;
            }
            const esModule = isEsModuleInput(code, inputType);
            if (esModule) {
                const lowered = await lowerToCommonJs(code, 'js', evalUrl(), '[eval]', true);
                if (lowered === null)
                    return 1;
                code = lowered;
            }
            return runProgram(code, {
                esModule,
                argv: args.slice(evalIdx + 2),
                filename: '<eval>',
                dirname: ctx.cwd || '/home/user',
                command: binSpawn?.command || `${name} -e ...`,
                stdin: programStdin,
                launchesServer: await launches(code, null, ctx.cwd || '/home/user', args.slice(evalIdx + 2)),
            });
        }
        // ── script path (or .wasm path for bypassesScriptRead) ──
        const scriptIdx = flagSpan;
        // No script: the REPL at a terminal, otherwise the program is stdin, as
        // Node decides between them by whether stdin is a TTY.
        const terminalInput = ctx.terminalStdin !== undefined && (ctx.stdin === undefined || ctx.stdin === ctx.terminalStdin) && ctx.isFdTerminal?.(0) !== false;
        if (args[scriptIdx] === undefined && spec.repl !== undefined && terminalInput && ctx.terminalStdin) {
            // The REPL takes Ctrl-C as input, as Node's readline does: the
            // terminal's signal keys are off while it runs (termios ISIG).
            const terminal = ctx.terminalStdin;
            terminal.signalKeys = false;
            try {
                return await runProgram(spec.repl, {
                    argv: args.slice(0, scriptIdx),
                    filename: '<repl>',
                    dirname: ctx.cwd || '/home/user',
                    command: binSpawn?.command || name,
                    stdin: { stdin: terminal },
                });
            }
            finally {
                terminal.signalKeys = true;
            }
        }
        const scriptPath = args[scriptIdx] ?? (spec.repl !== undefined && ctx.stdin !== undefined ? '-' : undefined);
        if (!scriptPath) {
            ctx.stderr.write(`${name}: no program. Use ${name} -e "code" or ${name} script.js\n`);
            return 1;
        }
        // ── `-`: the program is stdin ──
        //
        // Every runtime here reads it so (`node -`, `python -`, `ruby -`), and
        // `process.argv[1]` stays `-` so the script's own arguments start at
        // `process.argv[2]`, where a program written for real Node looks. The
        // program's own stdin is what is left after the read: nothing.
        if (scriptPath === '-') {
            let code = ctx.stdin ? (await ctx.stdin.readAll()) : '';
            const esModule = isEsModuleInput(code, inputType);
            if (esModule) {
                const lowered = await lowerToCommonJs(code, 'js', evalUrl(), '[stdin]', true);
                if (lowered === null)
                    return 1;
                code = lowered;
            }
            return runProgram(code, {
                esModule,
                argv: [...args.slice(0, scriptIdx), '-', ...args.slice(scriptIdx + 1)],
                filename: '[stdin]',
                dirname: ctx.cwd || '/home/user',
                command: binSpawn?.command || `${name} -`,
                launchesServer: await launches(code, null, ctx.cwd || '/home/user', ['-', ...args.slice(scriptIdx + 1)]),
            });
        }
        // ── bypassesScriptRead branch (wasm-runner) ──
        //
        // The runner takes the path AS-IS (it's a .wasm, not JS source).
        // We don't read or transform here; the runner reads the bytes
        // and instantiates them. `.` resolution and extension probing are
        // meaningless for a .wasm target and stay out of this branch.
        if (spec.bypassesScriptRead) {
            const filename = '/' + resolveVfsPath(scriptPath, ctx.cwd || '/home/user');
            const dirname = filename.includes('/')
                ? filename.substring(0, filename.lastIndexOf('/'))
                : '/';
            // `args.slice(scriptIdx + 1)` are the runner's user args (e.g.
            // [exportName, intArg1, intArg2, ...] for wasm-runner).
            return runProgram('', {
                argv: args.slice(scriptIdx + 1),
                filename,
                dirname,
                command: `${name} ${args.slice(0, scriptIdx + 1).join(' ')}`,
                reserved: false,
            });
        }
        // Resolve against cwd: `.` → the package entry, then extension probing.
        const resolvedPath = (await resolveRuntimeScriptPath(fs, ctx.cwd || '/home/user', scriptPath, {
            // bun prefers .module over .main when both exist; node uses .main.
            preferModuleField: name === 'bun',
        }));
        let code = null;
        if (resolvedPath !== null) {
            try {
                code = (await fs.readFileString(resolvedPath));
            }
            catch { /* unreadable — reported below */ }
        }
        if (resolvedPath === null || code === null) {
            ctx.stderr.write(`${name}: cannot find module '${scriptPath}'\n`);
            return 1;
        }
        // Shebang strip (primitive #1).
        if (code.startsWith('#!')) {
            const nl = code.indexOf('\n');
            code = nl >= 0 ? code.substring(nl + 1) : '';
        }
        // ── Module format ──
        //
        // A node facet runs every entry script as a CommonJS module body
        // (core/_shared/commonjs-cell.ts), so one Node runs as an ES module is
        // lowered first, decided as a real `node script.js` decides
        // (module-format.ts isEsModuleFile):
        //
        //   - .mjs          → always ESM
        //   - .cjs          → always CJS
        //   - .js           → as the nearest package.json's "type" says
        //   - no extension  → same rule as .js. Node allows an extensionless
        //                     main entry and resolves its format from the
        //                     package type, and that is the shape of nearly
        //                     every npm `bin` script (typescript's `bin/tsc`,
        //                     and the `node_modules/.bin/<cli>` target the bin
        //                     dispatcher hands us).
        //   - no "type"     → by its syntax: an import or export, import.meta,
        //                     a top-level await, or a top-level `const require`
        //                     (Node's syntax detection, on by default in 22).
        //
        // Without this, every modern ESM-only npm initialiser
        // (create-vite, create-astro, create-svelte, modern create-*)
        // crashes immediately with "Cannot use import statement outside
        // a module" because their bin entry is `index.js` and the
        // package.json declares `type: module`.
        //
        // We transform to CJS (format: 'cjs') so the facet runs it as a CJS
        // module body — same path that the bundle's `transformEsmInBundle`
        // (W3.5 Fix B) takes for sub-module ESM files. esbuild's CJS output
        // emits __require / module.exports / exports.X, ordinary CJS source.
        // The guest's registry could take the ES module itself, but not resolve
        // its package imports or give it the file's own URL (commonjs-cell.ts).
        const scriptExt = vfsPathExtension(resolvedPath);
        // The package scope's "type", through the resolver's own lookup.
        const packageType = scriptExt === '.js' || scriptExt === ''
            ? await packageScopeType({
                exists: (path) => fs.exists(path),
                isDirectory: (path) => isDirectory(fs, path),
                readFileString: (path) => fs.readFileString(path),
                stat: (path) => fs.stat(path),
            }, resolvedPath.slice(0, Math.max(0, resolvedPath.lastIndexOf('/'))))
            : null;
        // TypeScript by the same table the bundle's ESM pass reads.
        const typescript = typescriptLoader(resolvedPath);
        // esbuild transform for TypeScript / TSX / JSX (both node and bun)
        // AND for ESM entry scripts.
        const esm = typescript === null && scriptExt !== '.jsx' && isEsModuleFile(resolvedPath, code, () => packageType);
        if (typescript !== null || scriptExt === '.jsx' || esm) {
            const loader = typescript ?? (scriptExt === '.jsx' ? 'jsx' : 'js');
            const lowered = await lowerToCommonJs(code, loader, 'file:///' + resolvedPath.replace(/^\/+/, ''), scriptPath, esm);
            if (lowered === null)
                return 1;
            code = lowered;
        }
        const filename = '/' + resolvedPath;
        const dirname = filename.includes('/')
            ? filename.substring(0, filename.lastIndexOf('/'))
            : '/';
        return runProgram(code, {
            esModule: esm,
            argv: [...args.slice(0, scriptIdx), filename, ...args.slice(scriptIdx + 1)],
            filename,
            dirname,
            command: binSpawn?.command || `${name} ${args.slice(0, scriptIdx + 1).join(' ')}`,
            stdin: programStdin,
            // Judged on the code as it will run, after any TypeScript/ESM transform.
            launchesServer: await launches(code, resolvedPath, dirname, [filename, ...args.slice(scriptIdx + 1)]),
        });
    }
    return async function runtimeHandler(ctx) {
        const args = ctx.args || [];
        // ── Subcommand dispatch ──
        //
        // BEFORE flag-span computation: subcommands like `bun install`
        // have their first positional arg as the verb, NOT a node-style
        // flag. A verb owns the whole invocation, but it may hand a
        // rewritten argv back to the standard flow — that is how
        // `bun run <file>` reaches the same execution path as `bun <file>`.
        if (spec.subcommands && args.length > 0 && spec.subcommands[args[0]]) {
            return spec.subcommands[args[0]](ctx, registry, async (rewritten) => (await runtimeInvocation(ctx, rewritten)));
        }
        return (await runtimeInvocation(ctx, args));
    };
}
