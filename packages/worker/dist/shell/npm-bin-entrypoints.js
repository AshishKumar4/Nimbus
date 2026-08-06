import { resolveNpmBin, resolveNpmBinFromPath, isStagedArtifactTarget, stagedArtifactId, } from '../npm/bin-links.js';
import { bundleProfileForNpmBin } from '../runtime/bundle-profile.js';
import { OPENCODE_TREE_SITTER_DIAG_ARG } from '../runtime/opencode-facet-runner.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { DEFAULT_PATH, FACET_TIMEOUT_MS } from '../constants.js';
import { z } from 'zod/v4';
/**
 * How long a bin invocation may take before the shell stops waiting for it.
 *
 * The program itself is already bounded: FACET_TIMEOUT_MS kills a one-shot
 * facet and the session reports exit 124 with a reason. Nothing bounds the
 * supervisor-side work AROUND that run — the prefetch-bundle walk, the ESM
 * transform, staging a bundled artifact, the loader hop — and nothing bounds
 * the staged-artifact dispatch at all. A dispatch that never settles leaves
 * `running` stuck true on this connection's shell: every later keystroke is
 * swallowed, no prompt returns, and nothing says why. A terminal that goes
 * silent forever is worse than a command that fails.
 *
 * So the invocation gets the program's lifetime twice over: the program keeps
 * its full FACET_TIMEOUT_MS and the supervisor-side work gets the same again.
 * Derived rather than chosen, so it cannot drift from the bound it exists to
 * sit outside. Measured against a deployed Worker, the heaviest bins we run
 * sit far inside it: `pi --version` (a 17.4 MiB module map, the largest
 * observed) returns in 16s, and every staged-opencode one-shot in 2-4s.
 */
export const BIN_DISPATCH_TIMEOUT_MS = 2 * FACET_TIMEOUT_MS;
const DISPATCH_EXPIRED = Symbol('nimbus.bin-dispatch-expired');
/**
 * Await a bin dispatch under a bound. Reports expiry instead of hanging.
 *
 * The abandoned work keeps running — there is nothing to cancel it with, and a
 * facet that eventually finishes still lands its own exit and its write-back.
 * It just no longer holds the shell open, and it can never surface as an
 * unhandled rejection once we have stopped listening.
 */
export async function awaitBinDispatch(work, budgetMs) {
    let timer;
    const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(DISPATCH_EXPIRED), budgetMs);
    });
    try {
        return { expired: false, value: await Promise.race([work, deadline]) };
    }
    catch (e) {
        if (e !== DISPATCH_EXPIRED)
            throw e;
        work.catch(() => { });
        return { expired: true };
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/**
 * The reason a bin invocation is being abandoned. Names the limit and both
 * numbers it is derived from so the text cannot drift from the code, and says
 * where anything the program still produces will go.
 */
function dispatchExpiredReason(shellLine, pid) {
    return `${shellLine}: did not come back after ${BIN_DISPATCH_TIMEOUT_MS / 1000}s — the ` +
        `${FACET_TIMEOUT_MS / 1000}s a program is given to run, and the same again for the work ` +
        'around it. The shell is no longer waiting on it' +
        (pid === null ? '.' : `; anything it still produces goes to the log for pid ${pid}.`);
}
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
    const vfs = deps.vfs;
    const upstreamResolve = registry.resolve.bind(registry);
    registry.resolve = async function resolveWithNpmBins(name) {
        const upstream = await upstreamResolve(name);
        if (upstream)
            return upstream;
        const cwd = deps.getCwd() || '/home/user';
        if (!resolveNpmBinForInvocation(vfs, cwd, DEFAULT_PATH, name)) {
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
            const bin = resolveNpmBinForInvocation(vfs, invocationCwd, ctx.env?.PATH || DEFAULT_PATH, name);
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
                const disposition = classifyStagedArtifact(artifact, argv);
                return await runStagedArtifact(deps, name, artifact, argv, invocationCwd, ctx, disposition);
            }
            const bundleProfile = bundleProfileForNpmBin(bin);
            const metadata = readNpmBinPackageMetadata(vfs, bin.packagePath);
            const attachedTty = looksAttachedTtyNpmBin(metadata, argv, ctx.env);
            const longRunning = attachedTty || looksLongRunningNpmBin(name, argv);
            const runtimeName = npmBinRuntimeForTarget(vfs, bin.targetPath);
            const runtimeCmd = await upstreamResolve(runtimeName);
            if (typeof runtimeCmd !== 'function') {
                ctx.stderr.write(`${name}: ${runtimeName} command unavailable\n`);
                return 1;
            }
            const runRuntime = runtimeCmd;
            const shellLine = `${name} ${argv.join(' ')}`.trim();
            const entry = deps.processes.spawn(shellLine, [name, ...argv], invocationCwd, { longRunning, attachedTty, parentPid: ctx.pid });
            const pid = entry.pid;
            const startedAt = Date.now();
            if (longRunning)
                deps.processes.openInput(pid);
            const label = longRunning ? 'started (long-running)' : 'started';
            deps.terminal?.write(`\x1b[2m[bin ${label}: pid=${pid} cmd="${shellLine}"]\x1b[0m\r\n`);
            deps.notifyTerminalEvent({ type: 'spawn', pid, command: shellLine, longRunning, attachedTty });
            // Once the invocation is abandoned the terminal has moved on to the next
            // prompt, so late output must not be interleaved into it. The pid's log
            // still takes everything — that is where the rest of the run shows up.
            let abandoned = false;
            const writeThrough = (stream, target) => (data) => {
                const text = String(data);
                try {
                    deps.processes.appendOutput(pid, stream, text);
                }
                catch { }
                if (abandoned)
                    return;
                try {
                    target.write(text);
                }
                catch { }
            };
            let exitCode = 1;
            try {
                const dispatched = await awaitBinDispatch(Promise.resolve(runRuntime({
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
                })), BIN_DISPATCH_TIMEOUT_MS);
                if (dispatched.expired) {
                    writeThrough('stderr', ctx.stderr)(`${dispatchExpiredReason(shellLine, pid)}\n`);
                    abandoned = true;
                    exitCode = 124;
                }
                else {
                    exitCode = dispatched.value;
                }
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
async function runStagedArtifact(deps, name, artifact, argv, cwd, ctx, disposition) {
    const shellLine = `${name} ${argv.join(' ')}`.trim();
    const startedAt = Date.now();
    const fm = deps.getFacetManager();
    // Piped stdin is not yet wired for staged artifacts; the interactive TUI reads
    // keystrokes from the live ProcessInputStore via the attached-TTY stdin pump.
    const base = { argv, env: ctx.env ?? {}, cwd, command: shellLine };
    let dispatched;
    try {
        dispatched = await awaitBinDispatch(stagedArtifactWork(fm, artifact, base, disposition), BIN_DISPATCH_TIMEOUT_MS);
    }
    catch (e) {
        ctx.stderr.write(`${name}: ${formatError(e)}\n`);
        return 1;
    }
    // A staged artifact owns its own process-table entry and only tells us the
    // pid on the way out, so an abandoned dispatch has no pid to point at.
    if (dispatched.expired) {
        ctx.stderr.write(`${dispatchExpiredReason(shellLine, null)}\n`);
        return 124;
    }
    const result = dispatched.value;
    // Resident dispositions (dual / server / attached): the facet(s) are now
    // resident, streaming live and reporting their own exit through the
    // supervisor. Surface the long-running spawn and hand off — the same
    // lifecycle as a long-running attached node bin.
    if (disposition !== 'oneshot') {
        deps.terminal?.write(`\x1b[2m[bin started (long-running): pid=${result.pid} cmd="${shellLine}"]\x1b[0m\r\n`);
        deps.notifyTerminalEvent({
            type: 'spawn', pid: result.pid, command: shellLine, longRunning: true,
            attachedTty: disposition !== 'server',
        });
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
function stagedArtifactWork(fm, artifact, base, disposition) {
    switch (disposition) {
        case 'dual':
            return fm.execStagedArtifactDual(artifact, base);
        case 'server':
            return fm.execStagedArtifactServer(artifact, base);
        case 'attached':
            return fm.execStagedArtifact(artifact, { ...base, stdin: '', attachedTty: true });
        case 'oneshot':
            return fm.execStagedArtifact(artifact, { ...base, stdin: '', attachedTty: false });
        default: {
            const _exhaustive = disposition;
            throw new Error(`unknown staged-artifact disposition: ${String(_exhaustive)}`);
        }
    }
}
export function classifyStagedArtifact(artifact, argv) {
    if (artifact !== 'opencode')
        return 'oneshot';
    if (argv.some(isNonInteractiveBinArg))
        return 'oneshot';
    if (argv.includes(OPENCODE_TREE_SITTER_DIAG_ARG))
        return 'oneshot';
    const sub = argv.find((a) => !a.startsWith('-'));
    if (sub === undefined)
        return 'dual'; // bare `opencode` → serve + attach
    if (OPENCODE_SERVER_SUBCOMMANDS.has(sub))
        return 'server';
    if (OPENCODE_TUI_SUBCOMMANDS.has(sub))
        return 'attached';
    return 'oneshot';
}
const OPENCODE_SERVER_SUBCOMMANDS = new Set(['serve', 'web']);
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
/**
 * Whether this invocation stays resident. Only the keyed long-running facet
 * exposes a re-resolvable route stub, so getting this wrong for a server means
 * its port is never reachable — it runs in the one-shot facet until the facet
 * lifetime expires and reports the limit it hit.
 *
 * A server-shaped CLI serves by default; the exception is the subcommand that
 * ends. `build` is that verb, and it means the same thing in every one of
 * these CLIs: produce an artifact, exit. `preview` does not end — it binds a
 * port and serves the built output, exactly as `dev` binds one and serves the
 * source.
 *
 * The exclusion stays narrow because the two errors are not symmetric. A
 * missed server costs a dead port for one facet lifetime; a resident process
 * that exits 0 is never reaped (`handedOffToLongRunningFacet` above), so it
 * stays `running` in `ps` for the life of the session. Only verbs that
 * certainly terminate belong here.
 */
export function looksLongRunningNpmBin(binName, argv) {
    if (LONG_RUNNING_BIN_NAMES.has(binName)) {
        for (const arg of argv) {
            if (isNonInteractiveBinArg(arg))
                return false;
            if (arg === 'build')
                return false;
        }
        return true;
    }
    return argv.some((arg) => arg === '--watch' || arg === '-w' || arg === '--serve' || arg === '--dev');
}
function looksAttachedTtyNpmBin(metadata, argv, env) {
    if (argv.some(isNonInteractiveBinArg))
        return false;
    if (env?.NIMBUS_ATTACHED_TTY === '1')
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
