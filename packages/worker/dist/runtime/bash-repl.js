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
    active = null;
    ps2 = '> ';
    constructor(deps) {
        this.deps = deps;
    }
    get ps1() {
        const env = this.deps.shell?.getEnv() ?? this.deps.env;
        const cwd = this.deps.shell?.getCwd() ?? this.deps.cwd;
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
        await session?.close();
    }
    async interrupt() {
        const active = this.active;
        const session = this.session;
        active?.controller.abort();
        if (active && session)
            await session.interrupt();
        await active?.done;
        await this.resetSession();
    }
    async ensureSession(signal) {
        if (this.session)
            return null;
        this.session = await createBashFacetSession({
            facets: facetHostForManager(this.deps.facetMgr),
            authority: this.deps.authority,
            filesystem: this.deps.filesystem,
            pid: this.deps.pid,
            processes: this.deps.processes,
            cred: this.deps.cred,
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
            outputControls: [{ key: 'ps1', prefix: this.ps1Sentinel }, { key: 'ps2', prefix: this.ps2Sentinel }],
            signal,
        });
        const initial = this.session.initial;
        if (initial.state !== 'need-input')
            return this.consumeSlice(initial, '');
        if (this.promptKind(initial) === 'ps1')
            return null;
        return {
            kind: 'exit',
            exitCode: 1,
            stderr: 'bash: interactive boot did not reach PS1\n',
        };
    }
    sourceDelta(source) {
        if (this.incompleteSource === null)
            return source;
        const prior = `${this.incompleteSource}\n`;
        return source.startsWith(prior) ? source.slice(prior.length) : source;
    }
    consumeSlice(slice, source) {
        const prompt = this.promptKind(slice);
        if (slice.state === 'exited') {
            this.incompleteSource = null;
            return {
                kind: 'exit',
                exitCode: slice.exitCode,
            };
        }
        if (slice.state === 'error') {
            this.incompleteSource = null;
            return {
                kind: 'exit',
                exitCode: slice.exitCode || 1,
                stderr: `bash: ${slice.error || 'facet error'}\n`,
            };
        }
        if (prompt === 'ps2') {
            this.incompleteSource = source;
            return { kind: 'incomplete' };
        }
        if (prompt === 'ps1') {
            this.incompleteSource = null;
            return { kind: 'output', stdout: '', stderr: '' };
        }
        return {
            kind: 'exit',
            exitCode: 1,
            stderr: 'bash: interactive command did not reach a prompt\n',
        };
    }
    promptKind(slice) {
        if (slice.control?.ps1 !== undefined) {
            return 'ps1';
        }
        if (slice.control?.ps2 !== undefined) {
            return 'ps2';
        }
        return null;
    }
}
export async function runBashRepl(deps) {
    const session = new ReplSession(new BashReplAdapter(deps), deps.terminal, deps.shell);
    return await session.run();
}
