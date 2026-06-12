import { resolveNpmBin, resolveNpmBinFromPath, isStagedArtifactTarget, stagedArtifactId, } from '../npm/bin-links.js';
import { bundleProfileForNpmBin } from '../runtime/bundle-profile.js';
import { OPENCODE_TREE_SITTER_DIAG_ARG } from '../runtime/opencode-facet-runner.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { DEFAULT_PATH } from '../constants.js';
import { z } from 'zod/v4';
const NpmBinPackageMetadataSchema = z.object({
    name: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    nimbus: z.object({
        terminal: z.enum(['auto', 'attached', 'detached']).optional(),
    }).optional(),
}).passthrough();
export function installNpmBinFallbackResolver(registry, deps) {
    const upstreamResolve = registry.resolve.bind(registry);
    registry.resolve = async function resolveWithNpmBins(name) {
        const upstream = await upstreamResolve(name);
        if (upstream)
            return upstream;
        const cwd = deps.getCwd() || '/home/user';
        if (!resolveNpmBinForInvocation(deps.vfs, cwd, DEFAULT_PATH, name)) {
            let hint = null;
            try {
                hint = await deps.runtimeCommandHint(name);
            }
            catch {
                hint = null;
            }
            if (!hint)
                return undefined;
            const hintHandler = async (ctx) => {
                ctx.stderr.write(`${name}: command not found\n`);
                ctx.stderr.write(`hint: install it with: nimbus install ${hint.installSpec}\n`);
                return 127;
            };
            hintHandler.__nimbusRuntimeInstallHint = true;
            return hintHandler;
        }
        return async (ctx) => {
            const invocationCwd = ctx.cwd || '/home/user';
            const bin = resolveNpmBinForInvocation(deps.vfs, invocationCwd, ctx.env?.PATH || DEFAULT_PATH, name);
            if (!bin) {
                ctx.stderr.write(`${name}: command not found\n`);
                return 127;
            }
            const argv = Array.isArray(ctx.args) ? ctx.args.map(String) : [];
            // Staged-artifact sentinel (e.g. opencode): the runnable bundle lives in
            // the static-assets layer, not the VFS. Dispatch it through the
            // FacetManager's ESM-mainModule path instead of the node CJS runner.
            if (isStagedArtifactTarget(bin.targetPath)) {
                const artifact = stagedArtifactId(bin.targetPath);
                const attachedTty = looksAttachedTtyStagedArtifact(artifact, argv, ctx.env);
                return await runStagedArtifact(deps, name, artifact, argv, invocationCwd, ctx, attachedTty);
            }
            const bundleProfile = bundleProfileForNpmBin(bin);
            const metadata = readNpmBinPackageMetadata(deps.vfs, bin.packagePath);
            const attachedTty = looksAttachedTtyNpmBin(metadata, argv, ctx.env);
            const longRunning = attachedTty || looksLongRunningNpmBin(name, argv);
            const runtimeName = npmBinRuntimeForTarget(deps.vfs, bin.targetPath);
            const runtimeCmd = await upstreamResolve(runtimeName);
            if (typeof runtimeCmd !== 'function') {
                ctx.stderr.write(`${name}: ${runtimeName} command unavailable\n`);
                return 1;
            }
            const runRuntime = runtimeCmd;
            const shellLine = `${name} ${argv.join(' ')}`.trim();
            const entry = deps.processes.spawn(shellLine, [name, ...argv], invocationCwd, { longRunning, attachedTty });
            const pid = entry.pid;
            const startedAt = Date.now();
            if (longRunning)
                deps.processes.openInput(pid);
            const label = longRunning ? 'started (long-running)' : 'started';
            deps.terminal?.write(`\x1b[2m[bin ${label}: pid=${pid} cmd="${shellLine}"]\x1b[0m\r\n`);
            deps.notifyTerminalEvent({ type: 'spawn', pid, command: shellLine, longRunning });
            const writeThrough = (stream, target) => (data) => {
                const text = String(data);
                try {
                    deps.processes.appendOutput(pid, stream, text);
                }
                catch { }
                try {
                    target.write(text);
                }
                catch { }
            };
            let exitCode = 1;
            try {
                exitCode = await runRuntime({
                    ...ctx,
                    args: ['/' + bin.targetPath, ...argv],
                    stdout: { write: writeThrough('stdout', ctx.stdout) },
                    stderr: { write: writeThrough('stderr', ctx.stderr) },
                    __nimbusBinSpawn: {
                        skipSpawn: true,
                        callerPid: pid,
                        command: shellLine,
                        forceLongRunning: longRunning,
                        attachedTty,
                    },
                    __nimbusBundleProfile: bundleProfile,
                });
            }
            catch (e) {
                writeThrough('stderr', ctx.stderr)(`bin error: ${formatError(e)}\n`);
                exitCode = 1;
            }
            finally {
                const handedOffToLongRunningFacet = longRunning && exitCode === 0;
                if (!handedOffToLongRunningFacet) {
                    try {
                        deps.processes.exit(pid, exitCode);
                    }
                    catch { }
                    try {
                        if (!deps.processes.getExit(pid))
                            deps.processes.markExit(pid, exitCode);
                    }
                    catch { }
                    deps.notifyTerminalEvent({ type: 'exit', pid, code: exitCode, command: shellLine });
                    deps.emitShellExecDone(pid, shellLine, exitCode, Date.now() - startedAt);
                }
            }
            return exitCode;
        };
    };
}
function resolveNpmBinForInvocation(vfs, cwd, envPath, name) {
    return resolveNpmBinFromPath(vfs, cwd, envPath, name)
        ?? resolveNpmBin(vfs, cwd, name);
}
async function runStagedArtifact(deps, name, artifact, argv, cwd, ctx, attachedTty) {
    const shellLine = `${name} ${argv.join(' ')}`.trim();
    const startedAt = Date.now();
    let result;
    try {
        result = await deps.getFacetManager().execStagedArtifact(artifact, {
            argv,
            env: ctx.env ?? {},
            cwd,
            // Piped stdin is not yet wired for staged artifacts; the proven matrix
            // is argv-based (--version/--help/run-to-model-resolution). The
            // interactive TUI reads keystrokes from the live ProcessInputStore via
            // the attached-TTY stdin pump rather than this seed string.
            stdin: '',
            command: shellLine,
            attachedTty,
        });
    }
    catch (e) {
        ctx.stderr.write(`${name}: ${formatError(e)}\n`);
        return 1;
    }
    // Attached-TTY TUI: the facet is now resident, streaming frames live to the
    // terminal and reading keystrokes; it reports its own exit through the
    // supervisor. Emit only the long-running spawn event and hand off (no exit /
    // exec-done here) — the same lifecycle as a long-running attached node bin.
    if (attachedTty) {
        deps.notifyTerminalEvent({ type: 'spawn', pid: result.pid, command: shellLine, longRunning: true });
        return 0;
    }
    if (result.stdout)
        ctx.stdout.write(result.stdout);
    if (result.stderr)
        ctx.stderr.write(result.stderr);
    // execStagedArtifact owns the process-table entry; it returns the
    // authoritative pid so we surface the terminal/exec-done lifecycle events
    // against the real pid (same signals as the node-bin path).
    deps.notifyTerminalEvent({ type: 'exit', pid: result.pid, code: result.exitCode, command: shellLine });
    deps.emitShellExecDone(result.pid, shellLine, result.exitCode, Date.now() - startedAt);
    return result.exitCode;
}
/**
 * Whether a staged-artifact invocation launches an interactive attached TUI.
 * For opencode: the default `opencode` command and `opencode attach` render the
 * TUI; `opencode run <prompt>`, `--version`/`--help`/`-v`/`-h`, and the Nimbus
 * tree-sitter diagnostic are non-interactive and stay on the one-shot path. An
 * explicit `--interactive` flag forces the TUI; FORCE_TTY/NIMBUS_ATTACHED_TTY
 * override for probes.
 */
function looksAttachedTtyStagedArtifact(artifact, argv, env) {
    if (artifact !== 'opencode')
        return false;
    if (argv.some(isNonInteractiveBinArg))
        return false;
    if (argv.includes(OPENCODE_TREE_SITTER_DIAG_ARG))
        return false;
    if (env?.NIMBUS_ATTACHED_TTY === '1' || env?.FORCE_TTY === '1')
        return true;
    if (argv.includes('--interactive'))
        return true;
    const sub = argv.find((a) => !a.startsWith('-'));
    if (sub === undefined)
        return true; // bare `opencode` → TUI
    return OPENCODE_TUI_SUBCOMMANDS.has(sub);
}
const OPENCODE_TUI_SUBCOMMANDS = new Set(['attach']);
function formatError(error) {
    if (error instanceof Error)
        return error.stack || error.message;
    return String(error);
}
function npmBinRuntimeForTarget(vfs, targetPath) {
    const firstLine = readFirstLine(vfs, targetPath);
    return shebangRuntime(firstLine) ?? 'node';
}
function readFirstLine(vfs, path) {
    try {
        const text = vfs.readFileString(path);
        const nl = text.indexOf('\n');
        return nl >= 0 ? text.slice(0, nl) : text;
    }
    catch {
        return null;
    }
}
function shebangRuntime(line) {
    if (!line?.startsWith('#!'))
        return null;
    const words = shebangWords(line.slice(2));
    const command = words[0]?.endsWith('/env') ? words[1] : words[0];
    if (!command)
        return null;
    const slash = command.lastIndexOf('/');
    const name = slash >= 0 ? command.slice(slash + 1) : command;
    return name === 'bun' ? 'bun' : name === 'node' ? 'node' : null;
}
function shebangWords(text) {
    const words = [];
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === ' ' || ch === '\t') {
            if (current) {
                words.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (current)
        words.push(current);
    return words;
}
const LONG_RUNNING_BIN_NAMES = new Set([
    'vite', 'next', 'astro', 'nuxt', 'remix', 'serve', 'http-server',
    'wrangler', 'nodemon', 'tsx', 'ts-node-dev', 'webpack-dev-server',
    'parcel', 'rollup', 'esbuild', 'turbo',
]);
const NON_INTERACTIVE_BIN_FLAGS = new Set([
    '--help',
    '-h',
    'help',
    '--version',
    '-v',
    'version',
]);
const ATTACHED_TTY_KEYWORDS = new Set([
    'tui',
    'terminal',
    'interactive',
    'coding-agent',
    'agent-cli',
    'ai-agent',
    'chat',
    'prompt',
]);
const ATTACHED_TTY_DEPENDENCIES = new Set([
    'ink',
    '@inkjs/ui',
    'blessed',
    'blessed-contrib',
    'react-blessed',
    'inquirer',
    '@inquirer/prompts',
    'enquirer',
    'prompts',
]);
const ATTACHED_TTY_DEPENDENCY_PREFIXES = [
    '@opentui/',
];
function looksLongRunningNpmBin(binName, argv) {
    if (LONG_RUNNING_BIN_NAMES.has(binName)) {
        for (const arg of argv) {
            if (isNonInteractiveBinArg(arg))
                return false;
            if (arg === 'build' || arg === 'preview')
                return false;
        }
        return true;
    }
    return argv.some((arg) => arg === '--watch' || arg === '-w' || arg === '--serve' || arg === '--dev');
}
function looksAttachedTtyNpmBin(metadata, argv, env) {
    if (argv.some(isNonInteractiveBinArg))
        return false;
    if (env?.NIMBUS_ATTACHED_TTY === '1' || env?.FORCE_TTY === '1')
        return true;
    const explicit = metadata?.nimbus?.terminal;
    if (explicit === 'attached')
        return true;
    if (explicit === 'detached')
        return false;
    if (!metadata)
        return false;
    return hasAttachedTtyKeyword(metadata) || hasAttachedTtyDependency(metadata);
}
function isNonInteractiveBinArg(arg) {
    return NON_INTERACTIVE_BIN_FLAGS.has(arg.trim().toLowerCase());
}
function readNpmBinPackageMetadata(vfs, packagePath) {
    try {
        const manifestPath = normalizeVfsPath(`${packagePath}/package.json`);
        const parsed = NpmBinPackageMetadataSchema.safeParse(JSON.parse(vfs.readFileString(manifestPath)));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
function hasAttachedTtyKeyword(metadata) {
    for (const keyword of metadata.keywords ?? []) {
        if (ATTACHED_TTY_KEYWORDS.has(keyword.trim().toLowerCase()))
            return true;
    }
    return false;
}
function hasAttachedTtyDependency(metadata) {
    for (const dependencies of [
        metadata.dependencies,
        metadata.optionalDependencies,
        metadata.peerDependencies,
    ]) {
        if (!dependencies)
            continue;
        for (const name of Object.keys(dependencies)) {
            if (isAttachedTtyDependency(name))
                return true;
        }
    }
    return false;
}
function isAttachedTtyDependency(name) {
    const normalized = name.trim().toLowerCase();
    if (ATTACHED_TTY_DEPENDENCIES.has(normalized))
        return true;
    return ATTACHED_TTY_DEPENDENCY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
