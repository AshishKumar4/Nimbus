import { bindProcessView } from '../../../runtime/process-files.js';
import { syscallError } from '../../../vfs/vfs-error.js';
import { lex } from './lexer.js';
import { parse } from './parser.js';
import { expandWords, expandWord, evaluateSubscript, ExpansionError, } from './expander.js';
import { evaluateDoubleBracketWords } from './test-builtin.js';
import { isPipeEnd, PipeChannel } from './pipe.js';
import { exitCodeForAbortSignal, KILLED_BY_SIGPIPE } from './signals.js';
import { isBrokenPipe } from '../utils/bytes-io.js';
import { resolve } from '../utils/path.js';
import { encode } from '../utils/encoding.js';
import { globMatch } from '../utils/glob.js';
import { staticStdinReader } from '../../../shell/stdin-adapter.js';
import { statOrThrow } from '../../../vfs/vfs.js';
/**
 * Bytes a file-backed descriptor holds before committing. Matches the stream
 * chunk size used elsewhere and keeps a line-at-a-time producer from paying a
 * store write per line.
 */
const FILE_WRITE_BLOCK_BYTES = 64 * 1024;
function concatBytes(parts, total) {
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
// ─── Signal classes for control flow ───
export class BreakSignal {
    levels;
    constructor(levels) {
        this.levels = levels;
    }
}
export class ContinueSignal {
    levels;
    constructor(levels) {
        this.levels = levels;
    }
}
export class ReturnSignal {
    exitCode;
    constructor(exitCode) {
        this.exitCode = exitCode;
    }
}
export class ErrexitSignal {
    exitCode;
    constructor(exitCode) {
        this.exitCode = exitCode;
    }
}
export class ExitSignal {
    exitCode;
    constructor(exitCode) {
        this.exitCode = exitCode;
    }
}
class RedirectionOpenError extends Error {
    target;
    fsError;
    constructor(target, fsError) {
        super(fsError instanceof Error ? fsError.message : String(fsError));
        this.target = target;
        this.fsError = fsError;
    }
}
function redirectionDiagnostic(error) {
    const code = typeof error.fsError === 'object' && error.fsError !== null
        && 'code' in error.fsError && typeof error.fsError.code === 'string'
        ? error.fsError.code
        : /^([A-Z][A-Z0-9]+):/.exec(error.message)?.[1];
    const reason = code === 'EACCES' || code === 'EPERM'
        ? 'Permission denied'
        : code === 'ENOENT'
            ? 'No such file or directory'
            : code === 'ENOTDIR'
                ? 'Not a directory'
                : code === 'EISDIR'
                    ? 'Is a directory'
                    : error.message;
    return `sh: ${error.target}: ${reason}\n`;
}
function exited(status) {
    return { status, signal: null };
}
/**
 * Assign a plain value to a name. A name that already holds an array keeps it:
 * `a=(x y); a=plain` sets `a[0]` and leaves `a[1]` alone, which is bash's rule
 * and the reason a variable's type only changes through `unset`.
 */
export function assignScalar(env, arrays, name, value) {
    const array = arrays.get(name);
    if (array === undefined)
        env[name] = value;
    else
        array[0] = value;
}
/**
 * One turn of the event loop, unclamped: setImmediate where the host has it
 * (Bun, Node, workerd with nodejs_compat), else a MessageChannel post. A
 * timer would do, but hosts clamp it to about a millisecond.
 */
const eventLoopHost = globalThis;
const yieldToEventLoop = typeof eventLoopHost.setImmediate === 'function'
    ? () => new Promise((resolve) => eventLoopHost.setImmediate(resolve))
    : (() => {
        const channel = new eventLoopHost.MessageChannel();
        const waiting = [];
        channel.port1.onmessage = () => waiting.shift()?.();
        return () => new Promise((resolve) => { waiting.push(resolve); channel.port2.postMessage(0); });
    })();
/** bash 5's builtins: in bash these run in the shell's own process. */
const BASH_BUILTINS = new Set([
    '.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'complete',
    'compopt', 'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false',
    'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd',
    'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return', 'set', 'shift', 'shopt', 'source',
    'suspend', 'test', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
]);
export class Interpreter {
    config;
    lastExitCode = 0;
    functions = new Map();
    persistentOutputFds = new Map();
    persistentInputFds = new Map();
    persistentTerminalOutputFds = new Set();
    persistentTerminalInputFds = new Set();
    /** Bridge handles held open past the `exec` that opened them, by descriptor. */
    persistentOutputHandles = new Map();
    persistentInputHandles = new Map();
    errexitSuppressionDepth = 0;
    exitTrapDepth = 0;
    /** One frame per running function call, holding the bindings `local` shadowed. */
    localFrames = [];
    constructor(config) {
        this.config = config;
    }
    /** The functions this shell defines, for a run whose own definitions must not outlast it (restoreFunctions). */
    saveFunctions() {
        return new Map(this.functions);
    }
    restoreFunctions(saved) {
        this.functions = new Map(saved);
    }
    /**
     * A child shell, as fork(2) makes one: its own copy of every piece of shell
     * state (variables and arrays, cwd, options, traps, readonly names,
     * aliases, functions, $?, the open descriptors), so nothing it changes
     * reaches this shell. Shared: the process registry and filesystem,
     * command registry and terminal; `$$` stays this shell's. Traps reset to
     * the default, except ignored ones, and the child runs its own EXIT trap
     * when it finishes (`finishChild`).
     */
    fork() {
        const parent = this.config;
        let cwd = parent.getCwd();
        const env = { ...parent.env };
        const config = {
            ...parent,
            env,
            jobTable: parent.jobTable.fork(),
            arrays: new Map(Array.from(parent.arrays, ([name, elements]) => [name, [...elements]])),
            getCwd: () => cwd,
            setCwd: (next) => { cwd = next; env.PWD = next; },
            options: { ...parent.options },
            traps: new Map(Array.from(parent.traps.entries()).filter(([, action]) => action === '')),
            readonlyNames: new Set(parent.readonlyNames),
            aliases: parent.aliases ? new Map(parent.aliases) : undefined,
        };
        const child = new Interpreter(config);
        child.lastExitCode = this.lastExitCode;
        child.functions = new Map(this.functions);
        child.persistentOutputFds = new Map(this.persistentOutputFds);
        child.persistentInputFds = new Map(this.persistentInputFds);
        child.persistentTerminalOutputFds = new Set(this.persistentTerminalOutputFds);
        child.persistentTerminalInputFds = new Set(this.persistentTerminalInputFds);
        child.persistentOutputHandles = new Map(this.persistentOutputHandles);
        child.persistentInputHandles = new Map(this.persistentInputHandles);
        for (const handle of child.persistentHandles())
            handle.refs++;
        child.localFrames = this.localFrames.map((frame) => new Map(frame));
        child.errexitSuppressionDepth = this.errexitSuppressionDepth;
        return child;
    }
    getLastExitCode() {
        return this.lastExitCode;
    }
    async executeScript(script, terminalStdin) {
        return (await this.executeScriptWithIo(script, this.createTerminalIo(terminalStdin)));
    }
    async executeScriptWithIo(script, io) {
        let exitCode = 0;
        try {
            for (const list of script.lists) {
                exitCode = await this.executeList(list, io);
            }
        }
        catch (error) {
            if (error instanceof ErrexitSignal) {
                exitCode = error.exitCode;
            }
            else if (error instanceof ExitSignal) {
                exitCode = error.exitCode;
            }
            else {
                throw error;
            }
        }
        this.lastExitCode = exitCode;
        return exitCode;
    }
    async executeLine(input, terminalStdin, options) {
        const io = this.createTerminalIo(terminalStdin, options?.terminalFds, options?.scriptMode === true, options?.stdin);
        if (options?.stdout)
            io.stdout = options.stdout;
        if (options?.stderr)
            io.stderr = options.stderr;
        if (options?.writeToTerminal)
            io.writeToTerminal = options.writeToTerminal;
        if (options?.commandContext)
            io.commandContext = options.commandContext;
        if (options?.commandIdentity)
            io.commandIdentity = options.commandIdentity;
        if (options?.runAs)
            io.runAs = options.runAs;
        if (options?.signal)
            io.signal = options.signal;
        if (options?.interactive)
            io.interactive = true;
        if (io.commandIdentity)
            io.vfs = bindProcessView(this.config.filesystem, {
                pid: io.commandIdentity.pid, cred: io.commandIdentity.cred, signal: io.signal,
            });
        try {
            const tokens = lex(input);
            const script = parse(tokens);
            const exitCode = await this.executeScriptWithIo(script, io);
            return await this.runExitTrap(exitCode, io, options?.runExitTrap === true);
        }
        catch (e) {
            if (e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal) {
                throw e;
            }
            if (e instanceof ErrexitSignal) {
                this.lastExitCode = e.exitCode;
                return e.exitCode;
            }
            if (e instanceof Error) {
                this.writeTerminal(io, `${e.message}\n`);
            }
            // A failed expansion aborts with 1, the way bash does; 2 is reserved for
            // the shell's own usage errors (syntax, bad builtin invocation).
            const exitCode = e instanceof ExpansionError ? 1 : 2;
            this.lastExitCode = exitCode;
            return exitCode;
        }
    }
    async executeList(list, io = {}) {
        const abortCode = this.abortExitCode(io);
        if (abortCode !== null)
            return abortCode;
        if (list.background) {
            const abortController = new AbortController();
            const commandText = this.getListCommandText(list);
            const backgroundIo = this.createCommandIo(io);
            backgroundIo.signal = abortController.signal;
            backgroundIo.registerProcess = false;
            backgroundIo.positionals = this.forkPositionals(io);
            const child = this.fork();
            const promise = (async () => {
                return await child.finishChild(async () => (await child.executeListEntries(list.entries, backgroundIo)), backgroundIo);
            })();
            const pid = this.config.processRegistry.spawn({
                command: commandText.split(' ')[0] || 'unknown',
                args: commandText.split(' '),
                cwd: this.config.getCwd(),
                env: { ...this.config.env },
                isForeground: false,
                promise,
                abortController,
            });
            const waitable = this.config.processRegistry.get(pid)?.promise ?? promise;
            const jobId = this.config.jobTable.add(commandText, waitable, abortController, pid);
            // `%N` (kill, fg, wait) names the job by the table's number.
            const registered = this.config.processRegistry.get(pid);
            if (registered)
                registered.jobId = jobId;
            this.config.env['!'] = String(pid);
            // An interactive bash reports the job; a script (bash -c) says nothing.
            if (io.interactive)
                this.writeTerminal(io, `[${jobId}] ${pid}\n`);
            // Don't auto-reap - let Shell collect zombies before next prompt
            // This matches Linux behavior where zombies persist until reaped
            return 0;
        }
        return (await this.executeListEntries(list.entries, io));
    }
    getListCommandText(list) {
        return list.entries.map((e) => e.pipeline.commands.map((c) => {
            if (c.type === 'simple_command') {
                return c.words.map((w) => w.map((p) => p.text).join('')).join(' ');
            }
            return c.type;
        }).join(' | ')).join(' ');
    }
    async executeListEntries(entries, io = {}) {
        let exitCode = 0;
        let skipNext = false;
        for (const entry of entries) {
            const abortCode = this.abortExitCode(io);
            if (abortCode !== null)
                return abortCode;
            if (!skipNext) {
                // Every command of an and-or list but the last runs with errexit ignored.
                exitCode = entry.connector === '&&' || entry.connector === '||'
                    ? await this.withErrexitSuppressed(async () => (await this.executePipeline(entry.pipeline, io)))
                    : await this.executePipeline(entry.pipeline, io);
            }
            // A status carried past a skipped command came from a guarded one.
            if (!skipNext)
                this.enforceErrexit(entry.connector, exitCode);
            skipNext = false;
            if (entry.connector === '&&' && exitCode !== 0) {
                skipNext = true;
            }
            else if (entry.connector === '||' && exitCode === 0) {
                skipNext = true;
            }
        }
        this.lastExitCode = exitCode;
        return exitCode;
    }
    async executePipeline(pipeline, io = {}) {
        const abortCode = this.abortExitCode(io);
        if (abortCode !== null)
            return abortCode;
        const commands = pipeline.commands;
        let exitCode;
        let statuses;
        if (commands.length === 1) {
            // Single command -- no piping needed
            exitCode = await this.executeCommand(commands[0], io);
            statuses = [exitCode];
        }
        else {
            ({ exitCode, statuses } = await this.executePipelineCommands(commands, io));
        }
        // Every element's status, as bash's PIPESTATUS (before `!` negates the pipeline's).
        this.config.arrays.set('PIPESTATUS', statuses.map(String));
        delete this.config.env.PIPESTATUS;
        if (pipeline.negated) {
            exitCode = exitCode === 0 ? 1 : 0;
        }
        return exitCode;
    }
    async executePipelineCommands(commands, io) {
        const pipes = [];
        const promises = [];
        const pipelineAbortController = new AbortController();
        const parentSignal = io.signal ?? this.config.getAbortSignal?.();
        let unlinkParentSignal;
        if (parentSignal?.aborted) {
            pipelineAbortController.abort(parentSignal.reason);
        }
        else if (parentSignal) {
            unlinkParentSignal = linkAbortSignal(parentSignal, pipelineAbortController);
        }
        try {
            for (let i = 0; i < commands.length; i++) {
                const abortCode = this.abortExitCode(io);
                if (abortCode !== null)
                    return { exitCode: abortCode, statuses: [abortCode] };
                const stdin = i > 0 ? pipes[i - 1].reader : undefined;
                let stdout;
                if (i < commands.length - 1) {
                    const pipe = new PipeChannel(pipelineAbortController.signal);
                    pipes.push(pipe);
                    stdout = pipe.writer;
                }
                const cmd = commands[i];
                const isLast = i === commands.length - 1;
                const commandStdin = stdin ?? (i === 0 ? io.stdin : undefined);
                const commandStdout = stdout ?? (isLast ? io.stdout : undefined);
                const cmdIo = this.createCommandIo(io);
                if (commandStdin)
                    cmdIo.stdin = commandStdin;
                else
                    delete cmdIo.stdin;
                if (commandStdout)
                    cmdIo.stdout = commandStdout;
                else
                    delete cmdIo.stdout;
                cmdIo.terminalFds = {
                    stdin: stdin ? false : io.terminalFds?.stdin,
                    stdout: stdout ? false : io.terminalFds?.stdout,
                    stderr: io.terminalFds?.stderr,
                };
                cmdIo.signal = pipelineAbortController.signal;
                cmdIo.positionals = this.forkPositionals(io);
                // Each element runs in a child shell (bash forks every one).
                const element = this.fork();
                const cmdPromise = (async () => {
                    try {
                        return await element.finishChild(async () => (await element.executeCommand(cmd, cmdIo)), cmdIo);
                    }
                    catch (e) {
                        if (e instanceof ExitSignal) {
                            return e.exitCode;
                        }
                        // A builtin wrote to a pipe whose reader is gone: in bash that kills
                        // the element's own subshell, so the element ends with SIGPIPE's status.
                        if (e?.code === 'EPIPE')
                            return 141;
                        throw e;
                    }
                    finally {
                        // Only the closed pipe reaches the other elements: each goes on
                        // until it writes to a pipe nobody reads (bash; no abort here).
                        if (i > 0)
                            pipes[i - 1].cancel();
                        if (i < commands.length - 1) {
                            pipes[i].close();
                        }
                    }
                })();
                promises.push(cmdPromise);
            }
            const results = await Promise.all(promises);
            if (this.config.options.pipefail) {
                for (let i = results.length - 1; i >= 0; i--) {
                    if (results[i] !== 0)
                        return { exitCode: results[i] ?? 1, statuses: results };
                }
            }
            return { exitCode: results[results.length - 1] ?? 0, statuses: results };
        }
        finally {
            unlinkParentSignal?.();
        }
    }
    async executeCommand(cmd, io = {}) {
        const abortCode = this.abortExitCode(io);
        if (abortCode !== null)
            return abortCode;
        switch (cmd.type) {
            case 'simple_command':
                return (await this.executeSimpleCommand(cmd, io));
            case 'double_bracket':
                return (await this.executeDoubleBracket(cmd, io));
            case 'if':
                return (await this.executeIf(cmd, io));
            case 'for':
                return (await this.executeFor(cmd, io));
            case 'while':
                return (await this.executeWhile(cmd, io));
            case 'until':
                return (await this.executeUntil(cmd, io));
            case 'case':
                return (await this.executeCase(cmd, io));
            case 'group':
                return (await this.executeGroup(cmd, io));
            case 'subshell':
                return (await this.executeSubshell(cmd, io));
            case 'function_def':
                return (await this.executeFunctionDef(cmd));
        }
    }
    async executeIf(node, io) {
        return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
            let exitCode = 0;
            for (const clause of node.clauses) {
                const condCode = await this.withErrexitSuppressed(async () => (await this.executeCompoundList(clause.condition, redirIo)));
                if (condCode === 0) {
                    exitCode = await this.executeCompoundList(clause.body, redirIo);
                    this.lastExitCode = exitCode;
                    return exitCode;
                }
            }
            if (node.elseBody) {
                exitCode = await this.executeCompoundList(node.elseBody, redirIo);
            }
            this.lastExitCode = exitCode;
            return exitCode;
        }));
    }
    async executeDoubleBracket(node, io) {
        return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
            const stdout = redirIo.stdout ?? this.terminalSink(redirIo);
            const stderr = redirIo.stderr ?? this.terminalSink(redirIo);
            const fds = this.createCommandFds(stdout, stderr, redirIo.stdin, redirIo);
            const builtinIo = this.createIoFromFds(redirIo, fds);
            const exitCode = await this.withFdFlush(fds, async () => (await evaluateDoubleBracketWords(node.words, this.createExpandContext(redirIo), redirIo.vfs ?? this.config.vfs, stderr, {
                vfs: builtinIo.vfs ?? this.config.vfs,
                cwd: this.config.getCwd(),
                stdin: builtinIo.stdin,
                stdout,
                stderr,
                terminalStdin: redirIo.terminalStdin,
                terminalFds: {
                    stdin: fds.terminalInputFds.has(0),
                    stdout: fds.terminalOutputFds.has(1),
                    stderr: fds.terminalOutputFds.has(2),
                },
                scriptMode: redirIo.scriptMode,
                isFdTerminal: (fd) => this.isFdTerminal(fds, fd),
                getPositionals: () => this.readPositionals(builtinIo),
                setPositionals: (nextArgs) => this.writePositionals(builtinIo, nextArgs),
                executeInline: async (input, options) => (await this.executeInline(input, builtinIo, options)),
                declareLocal: (name) => this.declareLocal(name),
                unsetFunction: (name) => this.functions.delete(name),
                shell: this.config,
                interactive: redirIo.interactive,
                getLastExitCode: () => this.lastExitCode,
            })));
            this.lastExitCode = exitCode;
            return exitCode;
        }));
    }
    loopTicks = 0;
    /**
     * A loop whose body never waits on I/O would run entirely on microtasks,
     * and no timer, Ctrl-C or `kill` could reach it. Every 64 iterations it
     * lets the event loop run. (Counted, not timed: workerd's clock stands
     * still while code runs.)
     */
    async loopTick() {
        if (++this.loopTicks % 64 === 0)
            await yieldToEventLoop();
    }
    async executeFor(node, io) {
        return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
            const expandCtx = this.createExpandContext(redirIo);
            let exitCode = 0;
            let values;
            if (node.words !== null) {
                values = await expandWords(node.words, expandCtx);
            }
            else {
                values = [...this.readPositionals(redirIo)];
            }
            for (const val of values) {
                await this.loopTick();
                const abortCode = this.abortExitCode(redirIo);
                if (abortCode !== null)
                    return abortCode;
                if (!this.assignEnv(node.variable, val)) {
                    this.writeTerminal(redirIo, `${node.variable}: readonly variable\n`);
                    return 1;
                }
                try {
                    exitCode = await this.executeCompoundList(node.body, redirIo);
                }
                catch (e) {
                    if (e instanceof BreakSignal) {
                        if (e.levels > 1)
                            throw new BreakSignal(e.levels - 1);
                        break;
                    }
                    if (e instanceof ContinueSignal) {
                        if (e.levels > 1)
                            throw new ContinueSignal(e.levels - 1);
                        continue;
                    }
                    throw e;
                }
            }
            this.lastExitCode = exitCode;
            return exitCode;
        }));
    }
    async executeWhile(node, io) {
        return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
            let exitCode = 0;
            while (true) {
                await this.loopTick();
                const abortCode = this.abortExitCode(redirIo);
                if (abortCode !== null)
                    return abortCode;
                const condCode = await this.withErrexitSuppressed(async () => (await this.executeCompoundList(node.condition, redirIo)));
                if (condCode !== 0)
                    break;
                try {
                    exitCode = await this.executeCompoundList(node.body, redirIo);
                }
                catch (e) {
                    if (e instanceof BreakSignal) {
                        if (e.levels > 1)
                            throw new BreakSignal(e.levels - 1);
                        break;
                    }
                    if (e instanceof ContinueSignal) {
                        if (e.levels > 1)
                            throw new ContinueSignal(e.levels - 1);
                        continue;
                    }
                    throw e;
                }
            }
            this.lastExitCode = exitCode;
            return exitCode;
        }));
    }
    async executeUntil(node, io) {
        return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
            let exitCode = 0;
            while (true) {
                await this.loopTick();
                const abortCode = this.abortExitCode(redirIo);
                if (abortCode !== null)
                    return abortCode;
                const condCode = await this.withErrexitSuppressed(async () => (await this.executeCompoundList(node.condition, redirIo)));
                if (condCode === 0)
                    break;
                try {
                    exitCode = await this.executeCompoundList(node.body, redirIo);
                }
                catch (e) {
                    if (e instanceof BreakSignal) {
                        if (e.levels > 1)
                            throw new BreakSignal(e.levels - 1);
                        break;
                    }
                    if (e instanceof ContinueSignal) {
                        if (e.levels > 1)
                            throw new ContinueSignal(e.levels - 1);
                        continue;
                    }
                    throw e;
                }
            }
            this.lastExitCode = exitCode;
            return exitCode;
        }));
    }
    async executeCase(node, io) {
        return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
            const expandCtx = this.createExpandContext(redirIo);
            const wordValue = await expandWord(node.word, expandCtx);
            let exitCode = 0;
            for (const item of node.items) {
                for (const pattern of item.patterns) {
                    const patternValue = await expandWord(pattern, expandCtx);
                    if (globMatch(patternValue, wordValue)) {
                        exitCode = await this.executeCompoundList(item.body, redirIo);
                        this.lastExitCode = exitCode;
                        return exitCode;
                    }
                }
            }
            this.lastExitCode = exitCode;
            return exitCode;
        }));
    }
    async executeFunctionDef(node) {
        this.functions.set(node.name, node.body);
        return 0;
    }
    async executeGroup(node, io) {
        const exitCode = await this.executeWithRedirections(node.redirections, io, async (redirIo) => (await this.executeCompoundList(node.body, redirIo)));
        this.lastExitCode = exitCode;
        return exitCode;
    }
    async executeSubshell(node, io) {
        const child = this.fork();
        const subshellIo = this.createCommandIo(io);
        subshellIo.positionals = this.forkPositionals(io);
        let exitCode;
        try {
            exitCode = await child.executeWithRedirections(node.redirections, subshellIo, async (redirIo) => (await child.finishChild(async () => (await child.executeCompoundList(node.body, redirIo)), redirIo)));
        }
        finally {
            // A redirection that fails ends the child before its body, and so
            // before finishChild, runs.
            await child.closeDescriptors();
        }
        this.lastExitCode = exitCode;
        return exitCode;
    }
    async executeCompoundList(lists, io) {
        let exitCode = 0;
        for (const list of lists) {
            const abortCode = this.abortExitCode(io);
            if (abortCode !== null)
                return abortCode;
            exitCode = await this.executeList(list, io);
        }
        return exitCode;
    }
    async executeSimpleCommand(cmd, io) {
        const abortCode = this.abortExitCode(io);
        if (abortCode !== null)
            return abortCode;
        if (io.commandIdentity)
            io = { ...io, vfs: bindProcessView(this.config.filesystem, {
                    pid: io.commandIdentity.pid, cred: io.commandIdentity.cred, signal: io.signal,
                }) };
        const expandCtx = this.createExpandContext(io);
        // Expand words
        const expandedArgs = await expandWords(cmd.words, expandCtx);
        if (expandedArgs.length === 0 && cmd.assignments.length > 0) {
            // Bare assignment -- set env vars
            for (const assign of cmd.assignments) {
                if (!await this.applyAssignment(assign, expandCtx)) {
                    this.writeTerminal(io, `${assign.name}: readonly variable\n`);
                    if (io.scriptMode === true)
                        throw new ErrexitSignal(1);
                    return 1;
                }
            }
            // A command that is only assignments exits with the status of the last
            // command substitution it ran, so `out="$(cmd)" || die` sees cmd fail.
            return expandCtx.lastSubstitutionExitCode ?? 0;
        }
        if (expandedArgs.length === 0) {
            return 0;
        }
        let [name, ...args] = expandedArgs;
        // `exec utility [args]` runs the utility in place of this shell: its
        // status becomes the shell's exit status and nothing after it runs.
        const replacesShell = name === 'exec' && args.length > 0 && !(args.length === 1 && args[0] === '--');
        if (replacesShell)
            [name, ...args] = args[0] === '--' ? args.slice(1) : args;
        // Check alias expansion
        const aliases = replacesShell ? undefined : this.config.aliases;
        if (aliases) {
            const aliasValue = aliases.get(name);
            if (aliasValue !== undefined) {
                // Rebuild the command line with the alias expanded
                const expandedLine = aliasValue + (args.length > 0 ? ' ' + args.join(' ') : '');
                return (await this.executeLineWithIo(expandedLine, io));
            }
        }
        // Apply per-command assignments (temporary env)
        const saved = new Map();
        for (const assign of cmd.assignments) {
            if (!saved.has(assign.name))
                saved.set(assign.name, this.saveVariable(assign.name));
            if (!await this.applyAssignment(assign, expandCtx)) {
                (await (io.stderr ?? this.terminalSink(io)).write(`${assign.name}: readonly variable\n`));
                return 1;
            }
        }
        // Set up stdout/stderr (per-execution io target, then the terminal sink)
        let stdout = io.stdout ?? this.terminalSink(io);
        let stderr = io.stderr ?? this.terminalSink(io);
        let stdin = io.stdin;
        const fds = this.createCommandFds(stdout, stderr, stdin, io);
        try {
            await this.applyRedirections(cmd.redirections, fds, expandCtx, io, io.terminalStdin);
        }
        catch (error) {
            const redirStderr = fds.outputFds.get(2) ?? stderr;
            (await redirStderr.write(error instanceof RedirectionOpenError
                ? redirectionDiagnostic(error)
                : `${error instanceof Error ? error.message : String(error)}\n`));
            await this.flushFds(fds);
            this.lastExitCode = 1;
            return 1;
        }
        stdout = fds.outputFds.get(1) ?? this.createNullWriter();
        stderr = fds.outputFds.get(2) ?? this.createNullWriter();
        stdin = fds.inputFds.get(0);
        // If no stdin from pipe or redirect, fall back to terminal stdin
        if (!stdin && io.terminalStdin) {
            stdin = io.terminalStdin;
        }
        let exitCode;
        try {
            // Check for break/continue/return builtins
            if (name === 'break') {
                const levels = args[0] ? parseInt(args[0], 10) : 1;
                throw new BreakSignal(levels);
            }
            if (name === 'continue') {
                const levels = args[0] ? parseInt(args[0], 10) : 1;
                throw new ContinueSignal(levels);
            }
            if (name === 'return') {
                const code = args[0] ? parseInt(args[0], 10) : this.lastExitCode;
                throw new ReturnSignal(code);
            }
            if (name === 'exec' && args.length === 0) {
                await this.persistFdState(fds);
                exitCode = 0;
            }
            else {
                // Check functions
                const funcBody = replacesShell ? undefined : this.functions.get(name);
                if (funcBody) {
                    exitCode = await this.executeFunction(funcBody, args, this.createIoFromFds(io, fds));
                }
                else {
                    // Check builtins
                    const builtin = this.config.builtins.get(name);
                    if (builtin) {
                        const builtinIo = this.createIoFromFds(io, fds);
                        exitCode = await builtin(args, stdout, stderr, stdin, {
                            vfs: builtinIo.vfs ?? this.config.vfs,
                            cwd: this.config.getCwd(),
                            stdin,
                            stdout,
                            stderr,
                            terminalStdin: io.terminalStdin,
                            terminalFds: {
                                stdin: fds.terminalInputFds.has(0),
                                stdout: fds.terminalOutputFds.has(1),
                                stderr: fds.terminalOutputFds.has(2),
                            },
                            scriptMode: io.scriptMode,
                            isFdTerminal: (fd) => this.isFdTerminal(fds, fd),
                            getPositionals: () => this.readPositionals(builtinIo),
                            setPositionals: (nextArgs) => this.writePositionals(builtinIo, nextArgs),
                            executeInline: async (input, options) => (await this.executeInline(input, builtinIo, options)),
                            declareLocal: (name) => this.declareLocal(name),
                            unsetFunction: (name) => this.functions.delete(name),
                            shell: this.config,
                            interactive: io.interactive,
                            getLastExitCode: () => this.lastExitCode,
                        });
                    }
                    else {
                        // Check registry
                        const command = await this.config.registry.resolve(name, { cwd: this.config.getCwd() });
                        if (!command) {
                            (await stderr.write(`${name}: command not found\n`));
                            exitCode = 127;
                        }
                        else {
                            const identity = io.commandIdentity;
                            if (!identity)
                                throw new Error('shell command identity is unavailable');
                            const ended = await this.runCommand(command, name, args, {
                                commandContext: io.commandContext,
                                identity,
                                cwd: this.config.getCwd(),
                                env: { ...this.config.env },
                                vfs: io.vfs ?? this.config.vfs,
                                stdout,
                                stderr,
                                stdin,
                                terminalStdin: io.terminalStdin,
                                isFdTerminal: (fd) => this.isFdTerminal(fds, fd),
                                isFdPipe: (fd) => isPipeEnd(fds.outputFds.get(fd) ?? fds.inputFds.get(fd)),
                                signal: io.signal ?? this.config.getAbortSignal?.() ?? new AbortController().signal,
                                runAs: io.runAs,
                                register: io.registerProcess !== false,
                                shellBuiltin: BASH_BUILTINS.has(name),
                            });
                            exitCode = ended.status;
                            // A signalled command reports the SIGNAL's status, not whatever
                            // code it returned on its way out: `sleep` observes only that
                            // ctx.signal aborted, and cannot tell SIGINT (130) from
                            // SIGQUIT (131). The shell holds the reason, so it decides.
                            const signalledCode = this.abortExitCode(io);
                            if (signalledCode !== null)
                                exitCode = signalledCode;
                        }
                    }
                }
            }
        }
        finally {
            await this.flushFds(fds);
            // Restore env from per-command assignments
            for (const [name, value] of saved)
                this.restoreVariable(name, value);
        }
        const fatalSpecialBuiltin = io.scriptMode === true
            && exitCode !== 0
            && isFatalSpecialBuiltin(name);
        this.lastExitCode = exitCode;
        if (fatalSpecialBuiltin)
            throw new ErrexitSignal(exitCode);
        if (replacesShell)
            throw new ExitSignal(exitCode);
        return exitCode;
    }
    /**
     * execvp(3) of `argv`: argv[0] is found as a program is found (the
     * registry, then a path from `spec.cwd`), never as a function, an alias or
     * a builtin, and runs as a process on the streams it is handed. A program
     * that is not there is ENOENT, as execvp fails, for the caller to report.
     * One whose write finds its reader gone ends there, by SIGPIPE, and its
     * caller goes on, as the parent of a process SIGPIPE kills does.
     */
    async runProgram(argv, spec) {
        const [name, ...args] = argv;
        if (name === undefined)
            return exited(0);
        const command = await this.config.registry.resolve(name, { cwd: spec.cwd });
        if (!command)
            throw syscallError('ENOENT', 'execvp', name);
        return await this.runCommand(command, name, args, {
            ...spec,
            vfs: bindProcessView(this.config.filesystem, { pid: spec.identity.pid, cred: spec.identity.cred, signal: spec.signal }),
            register: true,
            shellBuiltin: false,
        });
    }
    /**
     * A resolved command, run as a process of this shell's: listed for ps,
     * jobs and kill while it runs, aborted with `spec.signal`, and its failure
     * (a closed pipe, an abort, a throw) turned into the status a process
     * would end with.
     */
    async runCommand(command, name, args, spec) {
        const abortController = new AbortController();
        const unlinkShellSignal = linkAbortSignal(spec.signal, abortController);
        const { identity, terminalStdin, stderr } = spec;
        let pid;
        const ctx = {
            ...spec.commandContext,
            pid: identity.pid,
            cred: identity.cred,
            args,
            env: spec.env,
            cwd: spec.cwd,
            vfs: spec.vfs,
            stdout: spec.stdout,
            stderr,
            signal: abortController.signal,
            stdin: spec.stdin,
            terminalStdin,
            setRawMode: terminalStdin
                ? (v) => { terminalStdin.rawMode = v; }
                : undefined,
            getRawMode: terminalStdin
                ? () => terminalStdin.rawMode
                : undefined,
            isFdTerminal: spec.isFdTerminal,
            isFdPipe: spec.isFdPipe,
            setUmask: identity.setUmask,
            runAs: async (cred, argv, options) => spec.runAs
                ? (await spec.runAs(options?.parent ?? ctx, cred, argv))
                : exited(126),
        };
        // Register process BEFORE executing so ps can see itself
        let commandPromise;
        if (spec.register) {
            let resolvePromise;
            let rejectPromise;
            const registeredPromise = new Promise((resolve, reject) => {
                resolvePromise = resolve;
                rejectPromise = reject;
            });
            pid = this.config.processRegistry.spawn({
                command: name,
                args: [name, ...args],
                cwd: spec.cwd,
                env: { ...spec.env },
                isForeground: true,
                promise: registeredPromise,
                abortController,
            });
            commandPromise = command(ctx).then((code) => {
                resolvePromise?.(code);
                return exited(code);
            }, async (err) => {
                if (isBrokenPipe(err)) {
                    // SIGPIPE: a builtin's ends its element (the catch below
                    // rethrows it); any other command alone dies, silently.
                    resolvePromise?.(KILLED_BY_SIGPIPE.status);
                    if (spec.shellBuiltin)
                        throw err;
                    return KILLED_BY_SIGPIPE;
                }
                rejectPromise?.(err);
                if (err instanceof Error && err.name === 'AbortError')
                    return exited(130);
                // Surface the failure: this rejection handler resolves
                // commandPromise to an exit code, so the catch below
                // never sees the error — without this write a throwing
                // registered command dies silently at the prompt.
                (await stderr.write(`${name}: ${err instanceof Error ? err.message : String(err)}\n`));
                return exited(1);
            });
        }
        else {
            commandPromise = command(ctx).then(exited);
        }
        try {
            return await commandPromise;
        }
        catch (e) {
            if (e instanceof Error && e.name === 'AbortError')
                return exited(130);
            if (isBrokenPipe(e)) {
                // A bash builtin's write is the shell's own: in bash SIGPIPE
                // kills the element's subshell, so its element ends.
                if (spec.shellBuiltin)
                    throw e;
                // Any other command is its own process: it alone dies, silently.
                return KILLED_BY_SIGPIPE;
            }
            (await stderr.write(`${name}: ${e instanceof Error ? e.message : String(e)}\n`));
            return exited(1);
        }
        finally {
            unlinkShellSignal();
            if (spec.register && pid !== undefined) {
                await Promise.resolve();
                this.config.processRegistry.reap(pid);
            }
        }
    }
    assignEnv(name, value) {
        if (this.config.readonlyNames.has(name))
            return false;
        assignScalar(this.config.env, this.config.arrays, name, value);
        return true;
    }
    /**
     * `name=value`, `name+=value`, `name[expr]=value` and `name=(word …)`.
     * Returns false when the name is readonly, which the caller reports.
     */
    async applyAssignment(assign, ctx) {
        const { name } = assign;
        if (this.config.readonlyNames.has(name))
            return false;
        if (assign.elements !== undefined) {
            const values = await expandWords(assign.elements, ctx);
            const existing = assign.append ? this.config.arrays.get(name) ?? [] : [];
            delete this.config.env[name];
            this.config.arrays.set(name, [...existing, ...values]);
            return true;
        }
        const value = await expandWord(assign.value, ctx);
        if (assign.subscript !== undefined) {
            const array = this.arrayFor(name);
            const index = await evaluateSubscript(assign.subscript, array.length, ctx);
            array[index] = assign.append ? (array[index] ?? '') + value : value;
            return true;
        }
        // A plain assignment to an array name lands on its first element, and
        // `arr+=x` appends to that element rather than adding one.
        const array = this.config.arrays.get(name);
        if (array !== undefined) {
            array[0] = assign.append ? (array[0] ?? '') + value : value;
            return true;
        }
        this.config.env[name] = assign.append ? (this.config.env[name] ?? '') + value : value;
        return true;
    }
    /** One variable's whole binding, so a scope can put it back exactly. */
    saveVariable(name) {
        return { scalar: this.config.env[name], array: this.config.arrays.get(name) };
    }
    restoreVariable(name, saved) {
        if (saved.array === undefined)
            this.config.arrays.delete(name);
        else
            this.config.arrays.set(name, saved.array);
        if (saved.scalar === undefined)
            delete this.config.env[name];
        else
            this.config.env[name] = saved.scalar;
    }
    /** The array behind a subscripted assignment, promoting a scalar if needed. */
    arrayFor(name) {
        const existing = this.config.arrays.get(name);
        if (existing !== undefined)
            return existing;
        const scalar = this.config.env[name];
        const array = scalar === undefined ? [] : [scalar];
        delete this.config.env[name];
        this.config.arrays.set(name, array);
        return array;
    }
    async executeFunction(body, args, io) {
        let exitCode;
        const functionIo = this.createCommandIo(io);
        functionIo.positionals = { args: [...args] };
        this.localFrames.push(new Map());
        try {
            exitCode = await this.executeCommand(body, functionIo);
        }
        catch (e) {
            if (e instanceof ReturnSignal) {
                exitCode = e.exitCode;
            }
            else {
                throw e;
            }
        }
        finally {
            const frame = this.localFrames.pop();
            if (frame !== undefined) {
                for (const [name, saved] of frame)
                    this.restoreVariable(name, saved);
            }
        }
        this.lastExitCode = exitCode;
        return exitCode;
    }
    /**
     * Bind a name to the running function, unset, so an assignment to it does
     * not outlive the call. Shell variables are dynamically scoped, so a callee
     * still sees its caller's locals — which is what bash does. Returns false
     * outside a function, where `local` is an error.
     */
    declareLocal(name) {
        const frame = this.localFrames[this.localFrames.length - 1];
        if (frame === undefined)
            return false;
        if (!frame.has(name))
            frame.set(name, this.saveVariable(name));
        delete this.config.env[name];
        this.config.arrays.delete(name);
        return true;
    }
    async executeCapture(input, io = {}) {
        let captured = '';
        const stdout = {
            write: (text) => { captured += text; },
        };
        const captureIo = this.createCommandIo(io);
        captureIo.stdout = stdout;
        captureIo.positionals = this.forkPositionals(io);
        // $( ) runs in a child shell.
        const child = this.fork();
        const exitCode = await child.finishChild(async () => (await child.executeLineWithIo(input, captureIo)), captureIo);
        return { output: captured, exitCode };
    }
    async executeInline(input, io, options = {}) {
        const inlineIo = this.createCommandIo(io);
        if (options.positionals !== undefined) {
            inlineIo.positionals = { args: [...options.positionals] };
        }
        return (await this.executeLineWithIo(input, inlineIo));
    }
    async executeLineWithIo(input, io) {
        const tokens = lex(input);
        const script = parse(tokens);
        return (await this.executeScriptWithIo(script, io));
    }
    /**
     * A child shell's run and end: it holds the files its io inherited while it
     * runs, its EXIT trap runs, an `exit` inside it ends only it, and its
     * descriptors close.
     */
    async finishChild(run, io) {
        // Taken before the first await: a background child starts here while its
        // parent goes on to close what it opened.
        const inherited = [...(io.openFiles?.values() ?? [])];
        for (const file of inherited)
            file.refs++;
        try {
            let exitCode;
            try {
                exitCode = await run();
            }
            catch (e) {
                if (!(e instanceof ExitSignal))
                    throw e;
                exitCode = e.exitCode;
            }
            return (await this.runExitTrap(exitCode, io, true));
        }
        finally {
            await this.release([...this.takeDescriptors(), ...inherited]);
        }
    }
    async runExitTrap(exitCode, io, enabled) {
        if (!enabled || this.exitTrapDepth > 0)
            return exitCode;
        const action = this.config.traps.get('EXIT');
        if (action === undefined)
            return exitCode;
        const savedLastExitCode = this.lastExitCode;
        this.lastExitCode = exitCode;
        this.exitTrapDepth++;
        try {
            await this.executeLineWithIo(action, io);
        }
        finally {
            this.exitTrapDepth--;
            this.lastExitCode = savedLastExitCode;
        }
        return exitCode;
    }
    createTerminalIo(terminalStdin, terminalFds, scriptMode, stdin) {
        const io = {};
        if (stdin)
            io.stdin = stdin;
        if (terminalStdin)
            io.terminalStdin = terminalStdin;
        if (terminalFds)
            io.terminalFds = terminalFds;
        if (scriptMode)
            io.scriptMode = true;
        return io;
    }
    createCommandIo(io) {
        const next = {};
        if (io.stdin)
            next.stdin = io.stdin;
        if (io.stdout)
            next.stdout = io.stdout;
        if (io.stderr)
            next.stderr = io.stderr;
        if (io.writeToTerminal)
            next.writeToTerminal = io.writeToTerminal;
        if (io.terminalStdin)
            next.terminalStdin = io.terminalStdin;
        if (io.terminalFds)
            next.terminalFds = io.terminalFds;
        if (io.scriptMode)
            next.scriptMode = true;
        if (io.signal)
            next.signal = io.signal;
        if (io.registerProcess === false)
            next.registerProcess = false;
        if (io.positionals)
            next.positionals = io.positionals;
        if (io.commandContext)
            next.commandContext = io.commandContext;
        if (io.commandIdentity)
            next.commandIdentity = io.commandIdentity;
        if (io.runAs)
            next.runAs = io.runAs;
        if (io.vfs)
            next.vfs = io.vfs;
        if (io.interactive)
            next.interactive = true;
        if (io.openFiles)
            next.openFiles = io.openFiles;
        return next;
    }
    /** Per-execution direct-terminal write, isolated from a nested capture. */
    writeTerminal(io, text) {
        (io.writeToTerminal ?? this.config.writeToTerminal)(text);
    }
    /** Late-bound fallback sink for command stdout/stderr with no fd target. */
    terminalSink(io) {
        return { write: (text) => this.writeTerminal(io, text) };
    }
    forkPositionals(io) {
        return { args: [...this.readPositionals(io)] };
    }
    createExpandContext(io = {}) {
        return {
            env: this.config.env,
            arrays: this.config.arrays,
            positionals: this.readPositionals(io),
            lastExitCode: this.lastExitCode,
            cwd: this.config.getCwd(),
            vfs: io.vfs ?? this.config.vfs,
            options: this.config.options,
            executeCapture: async (input) => (await this.executeCapture(input, io)),
        };
    }
    createIoFromFds(io, fds) {
        const next = this.createCommandIo(io);
        next.stdout = fds.outputFds.get(1) ?? this.createNullWriter();
        next.stderr = fds.outputFds.get(2) ?? this.createNullWriter();
        const stdin = fds.inputFds.get(0);
        if (stdin)
            next.stdin = stdin;
        else
            delete next.stdin;
        next.terminalFds = {
            stdin: fds.terminalInputFds.has(0),
            stdout: fds.terminalOutputFds.has(1),
            stderr: fds.terminalOutputFds.has(2),
        };
        if (fds.opened.size > 0)
            next.openFiles = new Map([...(io.openFiles ?? []), ...fds.opened]);
        return next;
    }
    readPositionals(io) {
        if (io.positionals)
            return io.positionals.args;
        const count = Number.parseInt(this.config.env['#'] ?? '0', 10);
        const args = [];
        for (let i = 1; i <= count; i++) {
            args.push(this.config.env[String(i)] ?? '');
        }
        return args;
    }
    writePositionals(io, args) {
        if (io.positionals) {
            io.positionals.args = [...args];
            return;
        }
        for (const key of Object.keys(this.config.env)) {
            if (key === '@' || key === '#' || /^[1-9][0-9]*$/.test(key)) {
                delete this.config.env[key];
            }
        }
        this.config.env['#'] = String(args.length);
        this.config.env['@'] = args.join(' ');
        for (let i = 0; i < args.length; i++) {
            this.config.env[String(i + 1)] = args[i];
        }
    }
    createCommandFds(stdout, stderr, stdin, io) {
        const outputFds = new Map([
            [1, stdout],
            [2, stderr],
            ...this.persistentOutputFds,
        ]);
        const inputFds = new Map([
            [0, stdin],
            ...this.persistentInputFds,
        ]);
        const terminalOutputFds = new Set(this.persistentTerminalOutputFds);
        setMembership(terminalOutputFds, 1, io.terminalFds?.stdout ?? !io.stdout);
        setMembership(terminalOutputFds, 2, io.terminalFds?.stderr ?? !io.stderr);
        const terminalInputFds = new Set(this.persistentTerminalInputFds);
        setMembership(terminalInputFds, 0, io.terminalFds?.stdin ?? (!stdin && Boolean(io.terminalStdin)));
        if (io.terminalStdin) {
            for (const fd of terminalInputFds) {
                inputFds.set(fd, io.terminalStdin);
            }
        }
        return {
            outputFds,
            inputFds,
            terminalOutputFds,
            terminalInputFds,
            changedOutputFds: new Set(),
            changedInputFds: new Set(),
            opened: new Map(),
            enclosing: io.openFiles ?? new Map(),
        };
    }
    async executeWithRedirections(redirections, io, execute) {
        if (redirections.length === 0) {
            return (await execute(io));
        }
        const expandCtx = this.createExpandContext(io);
        const stdout = io.stdout ?? this.terminalSink(io);
        const stderr = io.stderr ?? this.terminalSink(io);
        const fds = this.createCommandFds(stdout, stderr, io.stdin, io);
        // The flush owns every file the redirections open, including those opened
        // before one that fails to open or to expand.
        return (await this.withFdFlush(fds, async () => {
            try {
                await this.applyRedirections(redirections, fds, expandCtx, io, io.terminalStdin);
            }
            catch (error) {
                if (!(error instanceof RedirectionOpenError))
                    throw error;
                const redirStderr = fds.outputFds.get(2) ?? stderr;
                (await redirStderr.write(redirectionDiagnostic(error)));
                this.lastExitCode = 1;
                return 1;
            }
            return (await execute(this.createIoFromFds(io, fds)));
        }));
    }
    async applyRedirections(redirections, fds, expandCtx, io, terminalStdin) {
        for (const redir of redirections) {
            if (redir.operator === 'heredoc') {
                const heredoc = redir.heredoc ?? { body: '', quoted: false, stripTabs: false };
                const body = heredoc.quoted
                    ? heredoc.body
                    : await expandWord([{ text: heredoc.body, quoted: 'double' }], expandCtx);
                this.setInputFd(fds, redir.fd ?? 0, { stream: staticStdinReader(body), terminal: false });
                continue;
            }
            const target = await expandWord(redir.target, expandCtx);
            switch (redir.operator) {
                case 'write':
                    this.setOutputFd(fds, redir.fd ?? 1, (await this.openOutputTarget(io, target, 'write', fds, terminalStdin)));
                    break;
                case 'append':
                    this.setOutputFd(fds, redir.fd ?? 1, (await this.openOutputTarget(io, target, 'append', fds, terminalStdin)));
                    break;
                case 'read':
                    this.setInputFd(fds, redir.fd ?? 0, (await this.openInputTarget(io, target, fds, terminalStdin)));
                    break;
                case 'readWrite': {
                    const fd = redir.fd ?? 0;
                    this.setInputFd(fds, fd, (await this.openInputTarget(io, target, fds, terminalStdin)));
                    this.setOutputFd(fds, fd, (await this.openOutputTarget(io, target, 'append', fds, terminalStdin)));
                    break;
                }
                case 'writeAll': {
                    const writer = (await this.openOutputTarget(io, target, 'write', fds, terminalStdin));
                    this.setOutputFd(fds, 1, writer);
                    this.setOutputFd(fds, 2, writer);
                    break;
                }
                case 'dupOutput':
                    this.dupOutputFd(fds, redir.fd ?? 1, target);
                    break;
                case 'dupInput':
                    this.dupInputFd(fds, redir.fd ?? 0, target);
                    break;
            }
        }
    }
    async persistFdState(fds) {
        const released = [];
        for (const fd of fds.changedOutputFds) {
            const stream = fds.outputFds.get(fd);
            if (stream)
                this.persistentOutputFds.set(fd, stream);
            else
                this.persistentOutputFds.delete(fd);
            this.repointPersistentHandle(this.persistentOutputHandles, fd, stream, fds, released);
            if (fds.terminalOutputFds.has(fd))
                this.persistentTerminalOutputFds.add(fd);
            else
                this.persistentTerminalOutputFds.delete(fd);
        }
        for (const fd of fds.changedInputFds) {
            const isTerminal = fds.terminalInputFds.has(fd);
            const stream = isTerminal ? undefined : fds.inputFds.get(fd);
            if (fds.inputFds.has(fd)) {
                this.persistentInputFds.set(fd, stream);
            }
            else {
                this.persistentInputFds.delete(fd);
            }
            this.repointPersistentHandle(this.persistentInputHandles, fd, stream, fds, released);
            if (isTerminal)
                this.persistentTerminalInputFds.add(fd);
            else
                this.persistentTerminalInputFds.delete(fd);
        }
        // Every new reference is taken before any old one is let go, so a file
        // this `exec` moves to another descriptor (`exec 4>&3 3>&-`) stays open.
        await this.release(released);
    }
    /**
     * The shell's end: its descriptors close, as a process's do at exit(2). A
     * file closes with them unless something else still holds it.
     */
    async closeDescriptors() {
        await this.release(this.takeDescriptors());
    }
    /** Empty the descriptor table, returning one file per descriptor it held. */
    takeDescriptors() {
        const files = this.persistentHandles();
        this.persistentOutputFds.clear();
        this.persistentInputFds.clear();
        this.persistentTerminalOutputFds.clear();
        this.persistentTerminalInputFds.clear();
        this.persistentOutputHandles.clear();
        this.persistentInputHandles.clear();
        return files;
    }
    /** Let go of one reference per entry; a file nothing holds any more closes. */
    async release(files) {
        for (const file of files)
            file.refs--;
        const closing = new Set(files.filter((file) => file.refs === 0));
        const results = await Promise.allSettled([...closing].map((file) => file.close()));
        const failure = results.find((result) => result.status === 'rejected');
        if (failure)
            throw failure.reason;
    }
    /** One entry per descriptor, so a file `exec 4>&3` shares appears twice. */
    persistentHandles() {
        return [...this.persistentOutputHandles.values(), ...this.persistentInputHandles.values()];
    }
    /**
     * Point a descriptor `exec` keeps past its command at `stream`, holding a
     * reference on the file behind it: one this `exec` opened, one an enclosing
     * redirection holds (`{ exec 3>&1; } >f`), or one another descriptor names
     * (`exec 4>&3`). The file it named before goes to `released`.
     */
    repointPersistentHandle(handles, fd, stream, fds, released) {
        const held = handles.get(fd);
        if (held?.stream === stream)
            return;
        if (held) {
            handles.delete(fd);
            released.push(held);
        }
        if (stream === undefined)
            return;
        const file = [...this.persistentHandles(), ...released].find((open) => open.stream === stream)
            ?? fds.opened.get(stream)
            ?? fds.enclosing.get(stream);
        if (!file)
            return;
        file.refs++;
        handles.set(fd, file);
    }
    setOutputFd(fds, fd, target) {
        fds.outputFds.set(fd, target.stream);
        setMembership(fds.terminalOutputFds, fd, target.terminal);
        fds.changedOutputFds.add(fd);
    }
    setInputFd(fds, fd, target) {
        fds.inputFds.set(fd, target.stream);
        setMembership(fds.terminalInputFds, fd, target.terminal);
        fds.changedInputFds.add(fd);
    }
    dupOutputFd(fds, fd, target) {
        fds.changedOutputFds.add(fd);
        if (target === '-') {
            fds.outputFds.delete(fd);
            fds.terminalOutputFds.delete(fd);
            return;
        }
        const resolved = this.resolveOutputFd(target, fds.outputFds, fds.terminalOutputFds);
        fds.outputFds.set(fd, resolved.stream);
        setMembership(fds.terminalOutputFds, fd, resolved.terminal);
    }
    dupInputFd(fds, fd, target) {
        fds.changedInputFds.add(fd);
        if (target === '-') {
            fds.inputFds.delete(fd);
            fds.terminalInputFds.delete(fd);
            return;
        }
        const resolved = this.resolveInputFd(target, fds.inputFds, fds.terminalInputFds);
        fds.inputFds.set(fd, resolved.stream);
        setMembership(fds.terminalInputFds, fd, resolved.terminal);
    }
    async openOutputTarget(io, target, mode, fds, terminalStdin) {
        if (target === '/dev/null')
            return { stream: this.createNullWriter(), terminal: false };
        if (target === '/dev/tty') {
            if (!terminalStdin)
                throw new Error('/dev/tty: no controlling terminal');
            return { stream: this.terminalSink(io), terminal: true };
        }
        // /dev/stdout and /dev/stderr name the process's own descriptors, not
        // files. Writing them into the device provider would silently discard.
        if (target === '/dev/stdout')
            return this.resolveOutputFd('1', fds.outputFds, fds.terminalOutputFds);
        if (target === '/dev/stderr')
            return this.resolveOutputFd('2', fds.outputFds, fds.terminalOutputFds);
        const targetPath = resolve(this.config.getCwd(), target);
        const vfs = io.vfs ?? this.config.vfs;
        try {
            const bridge = vfs.process;
            const handle = await bridge.open(targetPath, { write: true, create: true, append: mode === 'append', truncate: mode === 'write' });
            const push = async (bytes) => {
                let offset = 0;
                while (offset < bytes.length) {
                    const written = await bridge.write(handle.id, null, bytes.subarray(offset));
                    if (written <= 0 || written > bytes.length - offset)
                        throw new Error('EIO: invalid redirection write length');
                    offset += written;
                }
            };
            const stream = { write: text => push(encode(text)), writeBytes: push };
            fds.opened.set(stream, { stream, close: async () => { await bridge.close(handle.id); }, refs: 1 });
            return { stream, terminal: false };
        }
        catch (error) {
            throw new RedirectionOpenError(target, error);
        }
    }
    async openInputTarget(io, target, fds, terminalStdin) {
        if (target === '/dev/null')
            return { stream: this.createEmptyReader(), terminal: false };
        if (target === '/dev/tty') {
            if (!terminalStdin)
                throw new Error('/dev/tty: no controlling terminal');
            return { stream: terminalStdin, terminal: true };
        }
        if (target === '/dev/stdin')
            return this.resolveInputFd('0', fds.inputFds, fds.terminalInputFds);
        const targetPath = resolve(this.config.getCwd(), target);
        const vfs = io.vfs ?? this.config.vfs;
        try {
            // Open-authorize before the command runs, the way open(2) would: a
            // missing, unreadable, or directory target fails the redirection even
            // when the command never reads a byte.
            if ((await statOrThrow(vfs, targetPath)).type === 'directory') {
                throw Object.assign(new Error(`EISDIR: ${targetPath}`), { code: 'EISDIR' });
            }
            await vfs.access(targetPath, 0o4);
            const bridge = vfs.process;
            const handle = await bridge.open(targetPath, { read: true });
            const stream = this.createFileReader(vfs, targetPath, (offset, length) => Promise.resolve(bridge.read(handle.id, offset, length)), true);
            fds.opened.set(stream, { stream, close: async () => { await bridge.close(handle.id); }, refs: 1 });
            return { stream, terminal: false };
        }
        catch (error) {
            throw new RedirectionOpenError(target, error);
        }
    }
    /**
     * A file-backed descriptor: an open file plus a write offset.
     *
     * Each write lands at the offset and advances it, the way write(2) does.
     * Restating the whole file per write — which is what this used to do —
     * makes every multi-write producer (`cat a b c`, a streaming `curl`, any
     * line-at-a-time filter) persist only its final write and silently drop
     * everything before it.
     *
     * Writes buffer to a block, as stdio does, so a line-at-a-time producer
     * costs one store write per block rather than one per line. `mode`
     * distinguishes `>` (a plain offset from the truncation point) from `>>`,
     * which is O_APPEND: every block lands at whatever the current end is, so
     * two descriptors appending to one file cannot overwrite each other.
     */
    createFileWriter(vfs, path, mode) {
        let offset = 0;
        let pending = [];
        let pendingBytes = 0;
        const endOfFile = async () => ((await vfs.exists(path)) ? (await statOrThrow(vfs, path)).size : 0);
        const flush = async () => {
            if (pendingBytes === 0)
                return;
            const block = pending.length === 1 ? pending[0] : concatBytes(pending, pendingBytes);
            pending = [];
            pendingBytes = 0;
            const at = mode === 'append' ? (await endOfFile()) : offset;
            (await vfs.writeRange(path, at, block));
            offset = at + block.length;
        };
        const push = async (bytes) => {
            if (bytes.length === 0)
                return;
            pending.push(bytes);
            pendingBytes += bytes.length;
            if (pendingBytes >= FILE_WRITE_BLOCK_BYTES)
                (await flush());
        };
        return {
            write: async (text) => (await push(encode(text))),
            writeBytes: async (bytes) => (await push(bytes)),
            flush,
        };
    }
    /**
     * Run `body` and commit every file-backed descriptor it wrote through,
     * whether it returned or threw. This is the close(2) side of the buffering
     * in createFileWriter: buffered bytes must reach the store before the next
     * command can read the file.
     */
    async withFdFlush(fds, body) {
        try {
            return await body();
        }
        finally {
            await this.flushFds(fds);
        }
    }
    async flushFds(fds) {
        const results = await Promise.allSettled([...new Set(fds.outputFds.values())].map(async (stream) => (await stream.flush?.())));
        const opened = [...fds.opened.values()];
        fds.opened.clear();
        try {
            await this.release(opened);
        }
        catch (reason) {
            results.push({ status: 'rejected', reason });
        }
        const failure = results.find((result) => result.status === 'rejected');
        if (failure)
            throw failure.reason;
    }
    /**
     * Byte-faithful redirected input: bounded range reads keep >64 KiB
     * redirections intact and preserve bytes that are not valid UTF-8, while
     * the text view still decodes progressively across chunk boundaries.
     *
     * Only a zero-length range means EOF. Devices and some mounts answer with
     * fewer bytes than asked whenever their internal bound is hit; those short
     * nonempty reads advance the offset and continue, exactly like read(2).
     */
    createFileReader(vfs, path, readRange = async (offset, length) => (await vfs.readRange(path, offset, length)), 
    /** A `< file` redirect: name the file and position (CommandInputStream.file), so a program's fd 0 can be the file. */
    namesFile = false) {
        const decoder = new TextDecoder('utf-8');
        let offset = 0;
        let eof = false;
        const file = namesFile ? { path, get offset() { return offset; } } : undefined;
        const pull = async (max) => {
            if (eof)
                return null;
            const chunk = await readRange(offset, max);
            if (chunk.length === 0) {
                eof = true;
                return null;
            }
            offset += chunk.length;
            return chunk;
        };
        return {
            ...(file ? { file } : {}),
            readBytes: async (maxLength) => {
                if (maxLength <= 0)
                    return new Uint8Array(0);
                return (await pull(maxLength));
            },
            read: async () => {
                while (true) {
                    const bytes = (await pull(65536));
                    if (bytes === null) {
                        const tail = decoder.decode();
                        return tail.length > 0 ? tail : null;
                    }
                    const text = decoder.decode(bytes, { stream: true });
                    if (text.length > 0)
                        return text;
                }
            },
            readAll: async () => {
                let out = '';
                while (true) {
                    const bytes = (await pull(65536));
                    if (bytes === null)
                        break;
                    out += decoder.decode(bytes, { stream: true });
                }
                out += decoder.decode();
                return out;
            },
            readLine: async () => {
                let line = '';
                let sawAny = false;
                while (true) {
                    const bytes = (await pull(65536));
                    if (bytes === null)
                        break;
                    sawAny = true;
                    // Split on the raw 0x0A byte so pushback returns ORIGINAL bytes;
                    // decoded-text pushback would corrupt multibyte sequences that
                    // straddle the chunk boundary or mis-measure invalid UTF-8.
                    const newline = bytes.indexOf(0x0a);
                    if (newline >= 0) {
                        offset -= bytes.length - (newline + 1);
                        eof = false;
                        line += decoder.decode(bytes.subarray(0, newline), { stream: true });
                        const flushed = decoder.decode();
                        return line + flushed;
                    }
                    line += decoder.decode(bytes, { stream: true });
                }
                line += decoder.decode();
                return sawAny || line.length > 0 ? line : null;
            },
        };
    }
    resolveOutputFd(target, outputFds, terminalOutputFds) {
        if (target === '-')
            return { stream: this.createNullWriter(), terminal: false };
        const fd = this.parseFdTarget(target);
        const stream = outputFds.get(fd);
        if (!stream)
            throw new Error(`bad output file descriptor: ${target}`);
        return { stream, terminal: terminalOutputFds.has(fd) };
    }
    resolveInputFd(target, inputFds, terminalInputFds) {
        if (target === '-')
            return { stream: this.createEmptyReader(), terminal: false };
        const fd = this.parseFdTarget(target);
        if (!inputFds.has(fd))
            throw new Error(`bad input file descriptor: ${target}`);
        return { stream: inputFds.get(fd), terminal: terminalInputFds.has(fd) };
    }
    parseFdTarget(target) {
        if (!isDecimalInteger(target))
            throw new Error(`bad file descriptor: ${target}`);
        return Number.parseInt(target, 10);
    }
    createNullWriter() {
        return { write: () => { }, writeBytes: () => { } };
    }
    createEmptyReader() {
        return { read: async () => null, readAll: async () => '', readLine: async () => null };
    }
    isFdTerminal(fds, fd) {
        if (fd === 0)
            return fds.terminalInputFds.has(fd);
        return fds.terminalOutputFds.has(fd);
    }
    enforceErrexit(connector, exitCode) {
        if (!this.config.options.errexit)
            return;
        if (this.errexitSuppressionDepth > 0)
            return;
        if (exitCode === 0)
            return;
        if (connector === '&&' || connector === '||')
            return;
        throw new ErrexitSignal(exitCode);
    }
    async withErrexitSuppressed(fn) {
        this.errexitSuppressionDepth++;
        try {
            return await fn();
        }
        finally {
            this.errexitSuppressionDepth--;
        }
    }
    abortExitCode(io) {
        const signal = io.signal ?? this.config.getAbortSignal?.();
        return signal?.aborted ? exitCodeForAbortSignal(signal) : null;
    }
}
function setMembership(set, value, present) {
    if (present)
        set.add(value);
    else
        set.delete(value);
}
function isDecimalInteger(value) {
    if (value.length === 0)
        return false;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 48 || code > 57)
            return false;
    }
    return true;
}
function isFatalSpecialBuiltin(name) {
    switch (name) {
        case ':':
        case '.':
        case 'break':
        case 'continue':
        case 'eval':
        case 'exec':
        case 'exit':
        case 'export':
        case 'readonly':
        case 'return':
        case 'set':
        case 'shift':
        case 'times':
        case 'trap':
        case 'unset':
            return true;
        default:
            return false;
    }
}
function linkAbortSignal(parent, child) {
    if (parent.aborted) {
        child.abort(parent.reason);
        return () => { };
    }
    const onAbort = () => child.abort(parent.reason);
    parent.addEventListener('abort', onAbort, { once: true });
    return () => parent.removeEventListener('abort', onAbort);
}
