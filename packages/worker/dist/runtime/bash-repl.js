import { formatShellPrompt } from '@nimbus-sh/core/substrate/lifo/shell/Shell.js';
import { createBashFacetSession } from '@nimbus-sh/core/runtime/bash-runner.js';
import { facetHostForManager } from './facet-loader-host.js';
import { ReplSession, } from './repl-session.js';
class BashReplAdapter {
    deps;
    ps1Sentinel = `__NIMBUS_BASH_PS1_${crypto.randomUUID()}__`;
    ps2Sentinel = `__NIMBUS_BASH_PS2_${crypto.randomUUID()}__`;
    session = null;
    incompleteSource = null;
    pendingStdout = '';
    pendingStderr = '';
    active = null;
    ps2 = '> ';
    constructor(deps) {
        this.deps = deps;
    }
    get ps1() {
        const env = this.deps.shell?.env ?? this.deps.env;
        const cwd = this.deps.shell?.cwd ?? this.deps.cwd;
        return formatShellPrompt(env, cwd);
    }
    banner() {
        return '';
    }
    push(source) {
        const controller = new AbortController();
        const done = this.evaluate(source, controller.signal);
        const active = { controller, done };
        this.active = active;
        const clear = () => { if (this.active === active)
            this.active = null; };
        void done.then(clear, clear);
        return done;
    }
    async evaluate(source, signal) {
        try {
            signal.throwIfAborted();
            const bootResult = await this.ensureSession(signal);
            signal.throwIfAborted();
            if (bootResult)
                return bootResult;
            const session = this.session;
            if (!session)
                throw new Error('Bash REPL is not initialized');
            const delta = this.sourceDelta(source);
            const slice = await session.push(`${delta}\n`);
            return this.consumeSlice(slice, source);
        }
        catch (error) {
            return {
                kind: 'error',
                stderr: `bash: ${error instanceof Error ? error.message : String(error)}\n`,
            };
        }
    }
    async close() {
        if (this.active)
            await this.interrupt();
        await this.resetSession();
    }
    async resetSession() {
        const session = this.session;
        this.session = null;
        this.incompleteSource = null;
        this.pendingStdout = '';
        this.pendingStderr = '';
        await session?.close();
    }
    async interrupt() {
        const active = this.active;
        const session = this.session;
        if (active && session && !session.interrupt) {
            throw new Error('Bash facet does not support interruption');
        }
        active?.controller.abort();
        if (active && session?.interrupt)
            await session.interrupt();
        await active?.done;
        await this.resetSession();
    }
    async ensureSession(signal) {
        if (this.session)
            return null;
        this.session = await createBashFacetSession({
            facets: facetHostForManager(this.deps.facetMgr),
            vfs: this.deps.vfs.as(this.deps.cred),
            manifest: this.deps.manifest,
            installRoot: this.deps.installRoot,
            argv: ['bash', '--noediting', '-i'],
            env: {
                ...this.deps.env,
                PS1: this.ps1Sentinel,
                PS2: this.ps2Sentinel,
                TERM: 'dumb',
            },
            cwd: this.deps.cwd,
            stdinClosed: false,
            stdinTty: true,
            signal,
        });
        const initial = this.session.initial;
        if (initial.state !== 'need-input')
            return this.consumeSlice(initial, '');
        const prompt = this.takePrompt(initial.stderr);
        this.pendingStdout += initial.stdout;
        this.pendingStderr += prompt.stderr;
        if (prompt.kind === 'ps1')
            return null;
        return {
            kind: 'exit',
            exitCode: 1,
            ...this.takeOutput(`bash: interactive boot did not reach PS1\n`),
        };
    }
    sourceDelta(source) {
        if (this.incompleteSource === null)
            return source;
        const prior = `${this.incompleteSource}\n`;
        return source.startsWith(prior) ? source.slice(prior.length) : source;
    }
    consumeSlice(slice, source) {
        const prompt = this.takePrompt(slice.stderr);
        this.pendingStdout += slice.stdout;
        this.pendingStderr += prompt.stderr;
        if (slice.state === 'exited') {
            this.incompleteSource = null;
            return {
                kind: 'exit',
                exitCode: slice.exitCode,
                ...this.takeOutput(),
            };
        }
        if (slice.state === 'error') {
            this.incompleteSource = null;
            return {
                kind: 'exit',
                exitCode: slice.exitCode || 1,
                ...this.takeOutput(`bash: ${slice.error || 'facet error'}\n`),
            };
        }
        if (prompt.kind === 'ps2') {
            this.incompleteSource = source;
            return { kind: 'incomplete' };
        }
        if (prompt.kind === 'ps1') {
            this.incompleteSource = null;
            return { kind: 'output', ...this.takeOutput() };
        }
        return {
            kind: 'exit',
            exitCode: 1,
            ...this.takeOutput('bash: interactive command did not reach a prompt\n'),
        };
    }
    takePrompt(stderr) {
        if (stderr.endsWith(this.ps1Sentinel)) {
            return {
                kind: 'ps1',
                stderr: stderr.slice(0, -this.ps1Sentinel.length),
            };
        }
        if (stderr.endsWith(this.ps2Sentinel)) {
            return {
                kind: 'ps2',
                stderr: stderr.slice(0, -this.ps2Sentinel.length),
            };
        }
        return { kind: null, stderr };
    }
    takeOutput(extraStderr = '') {
        const output = {
            stdout: this.pendingStdout,
            stderr: this.pendingStderr + extraStderr,
        };
        this.pendingStdout = '';
        this.pendingStderr = '';
        return output;
    }
}
export async function runBashRepl(deps) {
    const session = new ReplSession(new BashReplAdapter(deps), deps.terminal, deps.shell);
    return await session.run();
}
