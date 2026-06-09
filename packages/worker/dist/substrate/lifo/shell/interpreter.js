import { lex } from './lexer.js';
import { parse } from './parser.js';
import { expandWords, expandWord } from './expander.js';
import { PipeChannel } from './pipe.js';
import { exitCodeForAbortSignal } from './signals.js';
import { resolve } from '../utils/path.js';
import { globMatch } from '../utils/glob.js';
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
export class Interpreter {
    config;
    lastExitCode = 0;
    functions = new Map();
    persistentOutputFds = new Map();
    persistentInputFds = new Map();
    persistentTerminalOutputFds = new Set();
    persistentTerminalInputFds = new Set();
    errexitSuppressionDepth = 0;
    exitTrapDepth = 0;
    constructor(config) {
        this.config = config;
    }
    getLastExitCode() {
        return this.lastExitCode;
    }
    async executeScript(script, terminalStdin) {
        return this.executeScriptWithIo(script, this.createTerminalIo(terminalStdin));
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
            else {
                throw error;
            }
        }
        this.lastExitCode = exitCode;
        return exitCode;
    }
    async executeLine(input, terminalStdin, options) {
        try {
            const tokens = lex(input);
            const script = parse(tokens);
            const io = this.createTerminalIo(terminalStdin, options?.terminalFds, options?.scriptMode === true, options?.stdin);
            if (options?.stdout)
                io.stdout = options.stdout;
            if (options?.stderr)
                io.stderr = options.stderr;
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
                this.config.writeToTerminal(`${e.message}\n`);
            }
            this.lastExitCode = 2;
            return 2;
        }
    }
    async executeList(list, io = {}) {
        const abortCode = this.abortExitCode(io);
        if (abortCode !== null)
            return abortCode;
        if (list.background) {
            const abortController = new AbortController();
            const commandText = this.getListCommandText(list);
            const backgroundIo = this.createCommandIo({
                stdin: io.stdin,
                stdout: io.stdout,
                stderr: io.stderr,
                terminalStdin: io.terminalStdin,
                terminalFds: io.terminalFds,
                scriptMode: io.scriptMode,
                signal: abortController.signal,
                registerProcess: false,
                positionals: this.forkPositionals(io),
            });
            const promise = (async () => {
                return await this.executeListEntries(list.entries, backgroundIo);
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
            const jobId = this.config.jobTable.add(commandText, waitable, abortController);
            this.config.env['!'] = String(pid);
            this.config.writeToTerminal(`[${jobId}] ${pid} (background)\n`);
            // Don't auto-reap - let Shell collect zombies before next prompt
            // This matches Linux behavior where zombies persist until reaped
            return 0;
        }
        return this.executeListEntries(list.entries, io);
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
                exitCode = await this.executePipeline(entry.pipeline, io);
            }
            skipNext = false;
            this.enforceErrexit(entry.connector, exitCode);
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
        if (commands.length === 1) {
            // Single command -- no piping needed
            exitCode = await this.executeCommand(commands[0], io);
        }
        else {
            exitCode = await this.executePipelineCommands(commands, io);
        }
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
                    return abortCode;
                const stdin = i > 0 ? pipes[i - 1].reader : undefined;
                let stdout;
                if (i < commands.length - 1) {
                    const pipe = new PipeChannel();
                    pipes.push(pipe);
                    stdout = pipe.writer;
                }
                const cmd = commands[i];
                const isLast = i === commands.length - 1;
                const commandStdin = stdin ?? (i === 0 ? io.stdin : undefined);
                const commandStdout = stdout ?? (isLast ? io.stdout : undefined);
                const cmdIo = this.createCommandIo({
                    stdin: commandStdin,
                    stdout: commandStdout,
                    stderr: io.stderr,
                    terminalStdin: io.terminalStdin,
                    terminalFds: {
                        stdin: stdin ? false : io.terminalFds?.stdin,
                        stdout: stdout ? false : io.terminalFds?.stdout,
                        stderr: io.terminalFds?.stderr,
                    },
                    scriptMode: io.scriptMode,
                    signal: pipelineAbortController.signal,
                    registerProcess: io.registerProcess,
                    positionals: this.forkPositionals(io),
                });
                const cmdPromise = this.executeCommand(cmd, cmdIo)
                    .then((code) => {
                    if (i < commands.length - 1) {
                        pipes[i].close();
                    }
                    if (isLast) {
                        pipelineAbortController.abort();
                        for (const pipe of pipes)
                            pipe.close();
                    }
                    return code;
                });
                promises.push(cmdPromise);
            }
            const results = await Promise.all(promises);
            if (this.config.options.pipefail) {
                for (let i = results.length - 1; i >= 0; i--) {
                    if (results[i] !== 0)
                        return results[i] ?? 1;
                }
            }
            return results[results.length - 1] ?? 0;
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
                return this.executeSimpleCommand(cmd, io);
            case 'if':
                return this.executeIf(cmd, io);
            case 'for':
                return this.executeFor(cmd, io);
            case 'while':
                return this.executeWhile(cmd, io);
            case 'until':
                return this.executeUntil(cmd, io);
            case 'case':
                return this.executeCase(cmd, io);
            case 'group':
                return this.executeGroup(cmd, io);
            case 'subshell':
                return this.executeSubshell(cmd, io);
            case 'function_def':
                return this.executeFunctionDef(cmd);
        }
    }
    async executeIf(node, io) {
        return this.executeWithRedirections(node.redirections, io, async (redirIo) => {
            let exitCode = 0;
            for (const clause of node.clauses) {
                const condCode = await this.withErrexitSuppressed(() => this.executeCompoundList(clause.condition, redirIo));
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
        });
    }
    async executeFor(node, io) {
        return this.executeWithRedirections(node.redirections, io, async (redirIo) => {
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
                const abortCode = this.abortExitCode(redirIo);
                if (abortCode !== null)
                    return abortCode;
                if (!this.assignEnv(node.variable, val)) {
                    this.config.writeToTerminal(`${node.variable}: readonly variable\n`);
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
        });
    }
    async executeWhile(node, io) {
        return this.executeWithRedirections(node.redirections, io, async (redirIo) => {
            let exitCode = 0;
            while (true) {
                const abortCode = this.abortExitCode(redirIo);
                if (abortCode !== null)
                    return abortCode;
                const condCode = await this.withErrexitSuppressed(() => this.executeCompoundList(node.condition, redirIo));
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
        });
    }
    async executeUntil(node, io) {
        return this.executeWithRedirections(node.redirections, io, async (redirIo) => {
            let exitCode = 0;
            while (true) {
                const abortCode = this.abortExitCode(redirIo);
                if (abortCode !== null)
                    return abortCode;
                const condCode = await this.withErrexitSuppressed(() => this.executeCompoundList(node.condition, redirIo));
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
        });
    }
    async executeCase(node, io) {
        return this.executeWithRedirections(node.redirections, io, async (redirIo) => {
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
        });
    }
    async executeFunctionDef(node) {
        this.functions.set(node.name, node.body);
        return 0;
    }
    async executeGroup(node, io) {
        const exitCode = await this.executeWithRedirections(node.redirections, io, (redirIo) => this.executeCompoundList(node.body, redirIo));
        this.lastExitCode = exitCode;
        return exitCode;
    }
    async executeSubshell(node, io) {
        const savedCwd = this.config.getCwd();
        const savedEnv = { ...this.config.env };
        let exitCode = 0;
        const subshellIo = this.createCommandIo(io);
        subshellIo.positionals = this.forkPositionals(io);
        try {
            exitCode = await this.executeWithRedirections(node.redirections, subshellIo, (redirIo) => this.executeCompoundList(node.body, redirIo));
        }
        finally {
            this.config.setCwd(savedCwd);
            for (const key of Object.keys(this.config.env))
                delete this.config.env[key];
            Object.assign(this.config.env, savedEnv);
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
        const expandCtx = this.createExpandContext(io);
        // Expand words
        const expandedArgs = await expandWords(cmd.words, expandCtx);
        if (expandedArgs.length === 0 && cmd.assignments.length > 0) {
            // Bare assignment -- set env vars
            for (const assign of cmd.assignments) {
                const value = await expandWord(assign.value, expandCtx);
                if (!this.assignEnv(assign.name, value)) {
                    this.config.writeToTerminal(`${assign.name}: readonly variable\n`);
                    if (io.scriptMode === true)
                        throw new ErrexitSignal(1);
                    return 1;
                }
            }
            return 0;
        }
        if (expandedArgs.length === 0) {
            return 0;
        }
        const [name, ...args] = expandedArgs;
        // Check alias expansion
        const aliases = this.config.aliases;
        if (aliases) {
            const aliasValue = aliases.get(name);
            if (aliasValue !== undefined) {
                // Rebuild the command line with the alias expanded
                const expandedLine = aliasValue + (args.length > 0 ? ' ' + args.join(' ') : '');
                return this.executeLineWithIo(expandedLine, io);
            }
        }
        // Apply per-command assignments (temporary env)
        const savedEnv = {};
        for (const assign of cmd.assignments) {
            const value = await expandWord(assign.value, expandCtx);
            if (this.config.readonlyNames.has(assign.name)) {
                const redirStderr = io.stderr ?? this.config.defaultStderr;
                if (redirStderr) {
                    redirStderr.write(`${assign.name}: readonly variable\n`);
                }
                else {
                    this.config.writeToTerminal(`${assign.name}: readonly variable\n`);
                }
                return 1;
            }
            savedEnv[assign.name] = this.config.env[assign.name];
            this.assignEnv(assign.name, value);
        }
        // Set up stdout/stderr (default to config overrides, then terminal)
        let stdout = io.stdout ?? this.config.defaultStdout ?? {
            write: (text) => this.config.writeToTerminal(text),
        };
        let stderr = io.stderr ?? this.config.defaultStderr ?? {
            write: (text) => this.config.writeToTerminal(text),
        };
        let stdin = io.stdin;
        const fds = this.createCommandFds(stdout, stderr, stdin, io);
        try {
            await this.applyRedirections(cmd.redirections, fds, expandCtx, io.terminalStdin);
        }
        catch (error) {
            const redirStderr = fds.outputFds.get(2) ?? stderr;
            redirStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
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
                this.persistFdState(fds);
                exitCode = 0;
            }
            else {
                // Check functions
                const funcBody = this.functions.get(name);
                if (funcBody) {
                    exitCode = await this.executeFunction(funcBody, args, this.createIoFromFds(io, fds));
                }
                else {
                    // Check builtins
                    const builtin = this.config.builtins.get(name);
                    if (builtin) {
                        const builtinIo = this.createIoFromFds(io, fds);
                        exitCode = await builtin(args, stdout, stderr, stdin, {
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
                            executeInline: (input, options) => this.executeInline(input, builtinIo, options),
                        });
                    }
                    else {
                        // Check registry
                        const command = await this.config.registry.resolve(name);
                        if (!command) {
                            stderr.write(`${name}: command not found\n`);
                            exitCode = 127;
                        }
                        else {
                            const shouldRegister = io.registerProcess !== false;
                            let pid;
                            const abortController = new AbortController();
                            let unlinkShellSignal;
                            const shellSignal = io.signal ?? this.config.getAbortSignal?.() ?? new AbortController().signal;
                            unlinkShellSignal = linkAbortSignal(shellSignal, abortController);
                            const terminalStdin = io.terminalStdin;
                            const ctx = {
                                args,
                                env: { ...this.config.env },
                                cwd: this.config.getCwd(),
                                vfs: this.config.vfs,
                                stdout,
                                stderr,
                                signal: abortController.signal,
                                stdin,
                                terminalStdin,
                                setRawMode: terminalStdin
                                    ? (v) => { terminalStdin.rawMode = v; }
                                    : undefined,
                                getRawMode: terminalStdin
                                    ? () => terminalStdin.rawMode
                                    : undefined,
                                isFdTerminal: (fd) => this.isFdTerminal(fds, fd),
                            };
                            // Register process BEFORE executing so ps can see itself
                            let commandPromise;
                            if (shouldRegister) {
                                let resolvePromise;
                                let rejectPromise;
                                const registeredPromise = new Promise((resolve, reject) => {
                                    resolvePromise = resolve;
                                    rejectPromise = reject;
                                });
                                pid = this.config.processRegistry.spawn({
                                    command: name,
                                    args: [name, ...args],
                                    cwd: this.config.getCwd(),
                                    env: { ...this.config.env },
                                    isForeground: true,
                                    promise: registeredPromise,
                                    abortController,
                                });
                                commandPromise = command(ctx).then((code) => {
                                    resolvePromise?.(code);
                                    return code;
                                }, (err) => {
                                    const code = (err instanceof Error && err.name === 'AbortError') ? 130 : 1;
                                    rejectPromise?.(err);
                                    return code;
                                });
                            }
                            else {
                                commandPromise = command(ctx);
                            }
                            try {
                                exitCode = await commandPromise;
                            }
                            catch (e) {
                                if (e instanceof Error && e.name === 'AbortError') {
                                    exitCode = 130;
                                }
                                else {
                                    stderr.write(`${name}: ${e instanceof Error ? e.message : String(e)}\n`);
                                    exitCode = 1;
                                }
                            }
                            finally {
                                unlinkShellSignal?.();
                                if (shouldRegister && pid !== undefined) {
                                    await Promise.resolve();
                                    this.config.processRegistry.reap(pid);
                                }
                            }
                        }
                    }
                }
            }
        }
        finally {
            // Restore env from per-command assignments
            for (const [key, val] of Object.entries(savedEnv)) {
                if (val === undefined) {
                    delete this.config.env[key];
                }
                else {
                    this.config.env[key] = val;
                }
            }
        }
        const fatalSpecialBuiltin = io.scriptMode === true
            && exitCode !== 0
            && isFatalSpecialBuiltin(name);
        this.lastExitCode = exitCode;
        if (fatalSpecialBuiltin)
            throw new ErrexitSignal(exitCode);
        return exitCode;
    }
    assignEnv(name, value) {
        if (this.config.readonlyNames.has(name))
            return false;
        this.config.env[name] = value;
        return true;
    }
    async executeFunction(body, args, io) {
        let exitCode;
        const functionIo = this.createCommandIo(io);
        functionIo.positionals = { args: [...args] };
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
        this.lastExitCode = exitCode;
        return exitCode;
    }
    async executeCapture(input, io = {}) {
        let captured = '';
        const stdout = {
            write: (text) => { captured += text; },
        };
        const captureIo = this.createCommandIo(io);
        captureIo.stdout = stdout;
        captureIo.positionals = this.forkPositionals(io);
        await this.executeLineWithIo(input, captureIo);
        return captured;
    }
    async executeInline(input, io, options = {}) {
        const inlineIo = this.createCommandIo(io);
        if (options.positionals !== undefined) {
            inlineIo.positionals = { args: [...options.positionals] };
        }
        return this.executeLineWithIo(input, inlineIo);
    }
    async executeLineWithIo(input, io) {
        const tokens = lex(input);
        const script = parse(tokens);
        return this.executeScriptWithIo(script, io);
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
        return next;
    }
    forkPositionals(io) {
        return { args: [...this.readPositionals(io)] };
    }
    createExpandContext(io = {}) {
        return {
            env: this.config.env,
            positionals: this.readPositionals(io),
            lastExitCode: this.lastExitCode,
            cwd: this.config.getCwd(),
            vfs: this.config.vfs,
            options: this.config.options,
            executeCapture: (input) => this.executeCapture(input, io),
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
        setMembership(terminalOutputFds, 1, io.terminalFds?.stdout ?? (!this.config.defaultStdout && !io.stdout));
        setMembership(terminalOutputFds, 2, io.terminalFds?.stderr ?? (!this.config.defaultStderr && !io.stderr));
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
        };
    }
    async executeWithRedirections(redirections, io, execute) {
        if (redirections.length === 0) {
            return execute(io);
        }
        const expandCtx = this.createExpandContext(io);
        const stdout = io.stdout ?? this.config.defaultStdout ?? {
            write: (text) => this.config.writeToTerminal(text),
        };
        const stderr = io.stderr ?? this.config.defaultStderr ?? {
            write: (text) => this.config.writeToTerminal(text),
        };
        const fds = this.createCommandFds(stdout, stderr, io.stdin, io);
        await this.applyRedirections(redirections, fds, expandCtx, io.terminalStdin);
        return execute(this.createIoFromFds(io, fds));
    }
    async applyRedirections(redirections, fds, expandCtx, terminalStdin) {
        for (const redir of redirections) {
            if (redir.operator === 'heredoc') {
                const heredoc = redir.heredoc ?? { body: '', quoted: false, stripTabs: false };
                const body = heredoc.quoted
                    ? heredoc.body
                    : await expandWord([{ text: heredoc.body, quoted: 'double' }], expandCtx);
                this.setInputFd(fds, redir.fd ?? 0, { stream: this.createStringReader(body), terminal: false });
                continue;
            }
            const target = await expandWord(redir.target, expandCtx);
            switch (redir.operator) {
                case 'write':
                    this.setOutputFd(fds, redir.fd ?? 1, this.openOutputTarget(target, 'write', terminalStdin));
                    break;
                case 'append':
                    this.setOutputFd(fds, redir.fd ?? 1, this.openOutputTarget(target, 'append', terminalStdin));
                    break;
                case 'read':
                    this.setInputFd(fds, redir.fd ?? 0, this.openInputTarget(target, terminalStdin));
                    break;
                case 'readWrite': {
                    const fd = redir.fd ?? 0;
                    this.setInputFd(fds, fd, this.openInputTarget(target, terminalStdin));
                    this.setOutputFd(fds, fd, this.openOutputTarget(target, 'append', terminalStdin));
                    break;
                }
                case 'writeAll': {
                    const writer = this.openOutputTarget(target, 'write', terminalStdin);
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
    persistFdState(fds) {
        for (const fd of fds.changedOutputFds) {
            const stream = fds.outputFds.get(fd);
            if (stream)
                this.persistentOutputFds.set(fd, stream);
            else
                this.persistentOutputFds.delete(fd);
            if (fds.terminalOutputFds.has(fd))
                this.persistentTerminalOutputFds.add(fd);
            else
                this.persistentTerminalOutputFds.delete(fd);
        }
        for (const fd of fds.changedInputFds) {
            const isTerminal = fds.terminalInputFds.has(fd);
            if (fds.inputFds.has(fd)) {
                this.persistentInputFds.set(fd, isTerminal ? undefined : fds.inputFds.get(fd));
            }
            else {
                this.persistentInputFds.delete(fd);
            }
            if (isTerminal)
                this.persistentTerminalInputFds.add(fd);
            else
                this.persistentTerminalInputFds.delete(fd);
        }
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
    openOutputTarget(target, mode, terminalStdin) {
        if (target === '/dev/null')
            return { stream: this.createNullWriter(), terminal: false };
        if (target === '/dev/tty') {
            if (!terminalStdin)
                throw new Error('/dev/tty: no controlling terminal');
            return { stream: { write: (text) => this.config.writeToTerminal(text) }, terminal: true };
        }
        const targetPath = resolve(this.config.getCwd(), target);
        if (mode === 'write') {
            this.config.vfs.writeFile(targetPath, '');
            return { stream: this.createFileWriter(targetPath), terminal: false };
        }
        if (!this.config.vfs.exists(targetPath)) {
            this.config.vfs.writeFile(targetPath, '');
        }
        return { stream: this.createFileAppender(targetPath), terminal: false };
    }
    openInputTarget(target, terminalStdin) {
        if (target === '/dev/null')
            return { stream: this.createEmptyReader(), terminal: false };
        if (target === '/dev/tty') {
            if (!terminalStdin)
                throw new Error('/dev/tty: no controlling terminal');
            return { stream: terminalStdin, terminal: true };
        }
        return { stream: this.createFileReader(resolve(this.config.getCwd(), target)), terminal: false };
    }
    createFileWriter(path) {
        return {
            write: (text) => {
                this.config.vfs.writeFile(path, text);
            },
        };
    }
    createFileAppender(path) {
        return {
            write: (text) => {
                this.config.vfs.appendFile(path, text);
            },
        };
    }
    createFileReader(path) {
        const content = this.config.vfs.readFileString(path);
        return this.createStringReader(content);
    }
    createStringReader(content) {
        let offset = 0;
        return {
            read: async () => {
                if (offset >= content.length)
                    return null;
                const chunk = content.slice(offset);
                offset = content.length;
                return chunk;
            },
            readAll: async () => {
                if (offset >= content.length)
                    return '';
                const chunk = content.slice(offset);
                offset = content.length;
                return chunk;
            },
            readLine: async () => {
                if (offset >= content.length)
                    return null;
                const newline = content.indexOf('\n', offset);
                if (newline < 0) {
                    const line = content.slice(offset);
                    offset = content.length;
                    return line;
                }
                const line = content.slice(offset, newline);
                offset = newline + 1;
                return line;
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
        return { write: () => { } };
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
