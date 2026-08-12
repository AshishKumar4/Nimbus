/**
 * facet-process.ts — supervisor-side broker for child_process.spawn.
 *
 * W8 Phase 1: facet-mapped pseudo-process. Each child_process.spawn call from
 * a parent facet routes through here:
 *
 *   parent facet  ── SUPERVISOR.cpSpawn(req) ─→  FacetProcessManager.spawn
 *                                                      │
 *                                                      ▼
 *                                  one of two execution kinds:
 *
 *   pure-builtin   — run inline in supervisor isolate via the command
 *                    registry (echo, cat, true, false, ls, env, sleep,
 *                    exit-code, …). No facet hop. Fast.
 *
 *   facet-direct   — mint a child facet that runs the command directly
 *                    via FacetManager.execStream(). The facet IS the
 *                    command's runtime — no nested cpRunBuiltinCommand
 *                    recursion (that was the BLOCKER-2 deadlock vector
 *                    in the initial plan; see W8-plan.md §8.5).
 *
 * stdin / stdout / stderr stream through per-child queues maintained on
 * this manager instance. cpReadOutput long-polls for incremental delivery
 * to the parent; cpDrainOutput is a one-shot full-flush invoked from the
 * parent's exit path so unawaited children don't lose output.
 *
 * Lifecycle invariants:
 *   - exitCode is stamped exactly once (first writer wins). kill() and
 *     reportExit() race-free.
 *   - kill() resolves all pending waiters BEFORE invoking facets.abort,
 *     so cpWait/cpReadOutput don't hang on a torn-down facet.
 *   - facets.delete is deferred to a microtask after abort to give any
 *     in-flight reportExit RPC a chance to land (and be no-op'd by the
 *     idempotent guard).
 */
import { resolveVfsPath } from '../vfs/path.js';
import { parseShellInvocation } from '../shell/shell-invocation.js';
/** Cap recursion depth to defend against runaway spawn loops. */
export const CHILD_PROCESS_MAX_DEPTH = 8;
/**
 * Cap stdin queue per child to avoid unbounded memory consumption from a
 * fast parent against a slow child. cpStdinWrite returns ok=false past
 * the cap; the parent's Writable will then surface a 'drain'-needed
 * signal (real Node would return false from .write).
 */
const STDIN_QUEUE_MAX_BYTES = 256 * 1024; // 256 KiB
const STDIN_ATTACH_WAIT_MS = 500;
/**
 * How long the parent's cpReadOutput long-poll waits for new chunks
 * before returning empty. 250ms is the plan §3 target.
 */
const READ_OUTPUT_DEFAULT_WAIT_MS = 250;
/**
 * Cap on cpWait long-poll. Anything longer should be split into multiple
 * polls by the caller.
 */
const WAIT_MAX_MS = 30_000;
function basenameOfCommand(command) {
    const text = String(command || '').trim();
    if (!text)
        return '';
    const slash = text.lastIndexOf('/');
    return slash >= 0 ? text.slice(slash + 1) : text;
}
function isShellCommand(command) {
    const base = basenameOfCommand(command);
    return base === 'sh' || base === 'bash';
}
function normalizeVirtualCommand(command) {
    const text = String(command || '').trim();
    if (!text.startsWith('/'))
        return text;
    const base = basenameOfCommand(text);
    const dir = text.slice(0, Math.max(0, text.length - base.length));
    if (dir === '/bin/' || dir === '/usr/bin/' || dir === '/usr/local/bin/') {
        return base;
    }
    return text;
}
function shellNameForCommand(command) {
    return basenameOfCommand(command) === 'bash' ? 'bash' : 'sh';
}
function parseShellCommandArgs(command, args) {
    const parsed = parseShellInvocation(shellNameForCommand(command), args);
    if (!parsed.ok)
        return null;
    if (parsed.invocation.kind === 'command') {
        return { kind: 'command', commandLine: parsed.invocation.body, args: parsed.invocation.args };
    }
    if (parsed.invocation.kind === 'script') {
        return { kind: 'script', path: parsed.invocation.path, args: parsed.invocation.args };
    }
    // `bash --help` prints and exits; there is no process to spawn for it.
    if (parsed.invocation.kind === 'usage')
        return null;
    return { kind: 'stdin', args: parsed.invocation.args };
}
function quoteShellToken(value) {
    const text = String(value);
    if (text.length === 0)
        return "''";
    let simple = true;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        const ch = text[i];
        const ok = (code >= 48 && code <= 57) ||
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            ch === '_' || ch === '-' || ch === '.' || ch === '/' || ch === ':' || ch === '=';
        if (!ok) {
            simple = false;
            break;
        }
    }
    if (simple)
        return text;
    return "'" + text.split("'").join("'\\''") + "'";
}
function shellLineFromSpawn(command, args) {
    return [command, ...(Array.isArray(args) ? args : [])].map((part) => quoteShellToken(String(part))).join(' ');
}
export class FacetProcessManager {
    children = new Map();
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    // ── spawn ───────────────────────────────────────────────────────────────
    /**
     * Allocate a child PID, classify the command, dispatch to inline runner
     * or facet-direct runner. Returns immediately with the child PID; the
     * actual command executes asynchronously and pushes output via the
     * per-child hooks.
     */
    async spawn(req) {
        // Recursion-depth cap (env-propagated).
        const depthIn = parseInt(req.env?.NIMBUS_CP_DEPTH || '0', 10) || 0;
        if (depthIn >= CHILD_PROCESS_MAX_DEPTH) {
            throw new Error(`EAGAIN: child_process spawn depth ${depthIn} exceeds ` +
                `CHILD_PROCESS_MAX_DEPTH=${CHILD_PROCESS_MAX_DEPTH}`);
        }
        const childEnv = {
            ...req.env,
            NIMBUS_CP_DEPTH: String(depthIn + 1),
        };
        if (!Number.isInteger(req.parentPid) || req.parentPid <= 0) {
            throw new Error('child_process spawn requires a supervisor-assigned parent pid');
        }
        const commandLine = `${req.command} ${req.args.join(' ')}`.trim();
        const processEntry = this.deps.processes.spawn(commandLine, req.args, req.cwd, { parentPid: req.parentPid });
        const pid = processEntry.pid;
        const facetName = `cp-proc-${pid}`;
        const child = {
            pid,
            command: req.command,
            args: req.args || [],
            cwd: req.cwd,
            env: childEnv,
            facetName,
            startedAt: Date.now(),
            endedAt: null,
            stdinChunks: [],
            stdinClosed: false,
            stdinTotalBytes: 0,
            stdinWaiters: [],
            outputs: { 1: [], 2: [] },
            outputSeq: { 1: 0, 2: 0 },
            outputWaiters: [],
            exitCode: null,
            signal: null,
            killed: false,
            exitWaiters: [],
            facetSlot: null,
        };
        this.children.set(pid, child);
        const shellPlan = this._shellPlanFor(req);
        const normalizedCommand = shellPlan ? 'sh' : normalizeVirtualCommand(req.command);
        const dispatchReq = shellPlan
            ? req
            : { ...req, command: normalizedCommand };
        // Resolve command kind. Resolution failure → exit 127 (command not
        // found), no facet at all. Same shell semantics.
        const reg = shellPlan ? { kind: 'shell-direct' } : this.deps.commandRegistry.resolve(normalizedCommand);
        const kind = reg ? reg.kind : 'unknown';
        // Dispatch after the cpSpawn RPC has had a chance to return to the
        // parent facet. That lets immediate child.stdin.write(); child.stdin.end()
        // calls land in the stdin queue before a preseeded child runtime starts.
        setTimeout(() => {
            void this._dispatch(child, kind, dispatchReq).catch((e) => {
                // Last-resort: if both runners somehow throw, exit 1 with the error
                // on stderr.
                this._appendOutput(child, 2, `Error: ${e?.message || String(e)}\n`);
                this._stampExit(child, 1, null);
            });
        }, 0);
        return { childPid: pid };
    }
    /** Dispatch by kind. */
    async _dispatch(child, kind, req) {
        if (kind === 'unknown') {
            this._appendOutput(child, 2, `${req.command}: command not found\n`);
            this._stampExit(child, 127, null);
            return;
        }
        const hooks = {
            onStdout: (d) => this._appendOutput(child, 1, d),
            onStderr: (d) => this._appendOutput(child, 2, d),
        };
        // When configured, the pool moves the dispatch envelope into a Worker
        // Loader isolate and delegates command execution through supervisor RPC.
        if (this.deps.spawnPool) {
            const liveStdin = kind === 'facet-direct' || kind === 'shell-direct';
            // Pure builtins consume stdin from the request payload. Facet-direct
            // commands receive live stdin through NIMBUS_CP_CHILD_PID and
            // supervisor cpReadStdin, which matches Node child_process pipes.
            const stdin = liveStdin ? '' : await this._drainStdinForBuiltin(child);
            // Single-ownership: build a fresh request payload (not a reference
            // to the caller's req) at the boundary.
            const reqCopy = {
                command: String(req.command),
                args: Array.isArray(req.args) ? [...req.args] : [],
                env: liveStdin
                    ? { ...child.env, NIMBUS_CP_CHILD_PID: String(child.pid) }
                    : { ...child.env },
                cwd: String(req.cwd),
                stdio: req.stdio,
                detached: !!req.detached,
                shell: req.shell ?? false,
                stdin,
                processPid: child.pid,
            };
            // Register the facet-slot so kill() can find the abort handle.
            child.facetSlot = { abort: undefined, killed: false };
            try {
                const code = await this.deps.spawnPool.runOne(reqCopy, kind, hooks);
                this._stampExit(child, code, null);
            }
            catch (e) {
                this._appendOutput(child, 2, `spawn-pool error: ${e?.message || String(e)}\n`);
                this._stampExit(child, 1, null);
            }
            return;
        }
        // ── Legacy in-supervisor dispatch (unit-test path) ─────────────
        if (kind === 'shell-direct') {
            await this._dispatchShell(child, req, hooks);
            return;
        }
        if (kind === 'pure-builtin') {
            // Drain stdin synchronously — pure builtins are sync-style; they
            // expect a complete stdin string. The parent must call stdinEnd()
            // before this resolves. If the parent hasn't ended, we wait up to
            // 50ms for stdin then proceed with whatever's queued.
            const stdin = await this._drainStdinForBuiltin(child);
            try {
                const code = await this.deps.commandRegistry.runPureBuiltin(child.pid, req.command, req.args, child.env, req.cwd, stdin, hooks);
                this._stampExit(child, code, null);
            }
            catch (e) {
                this._appendOutput(child, 2, `Error: ${e?.message || String(e)}\n`);
                this._stampExit(child, 1, null);
            }
            return;
        }
        // facet-direct: ship a payload to the FacetManager.execStream that
        // describes the command. In production execStream wraps a generated
        // facet template that imports node:child_process internally; in the
        // unit-test mock the payload is interpreted by the test interpreter.
        const payload = JSON.stringify({
            command: req.command,
            args: req.args,
            env: { ...child.env, NIMBUS_CP_CHILD_PID: String(child.pid) },
            cwd: req.cwd,
            stdin: '',
            processPid: child.pid,
        });
        // Register the facet-slot so kill() can find the abort handle.
        child.facetSlot = { abort: undefined, killed: false };
        try {
            const code = await this.deps.facetMgr.execStream(payload, { facetName: child.facetName, cwd: req.cwd, env: child.env, argv: req.args }, hooks);
            this._stampExit(child, code, null);
        }
        catch (e) {
            this._appendOutput(child, 2, `facet error: ${e?.message || String(e)}\n`);
            this._stampExit(child, 1, null);
        }
    }
    /**
     * child-process isolation gap #1: inline dispatch — runs the existing
     * pure-builtin / facet-direct logic with string-collecting hooks
     * and returns the final {exitCode, stdout, stderr} envelope.
     *
     * Called by _rpcCpDispatchInline (src/session/rpc.ts) which is in
     * turn called by the spawn-facet running inside a fresh Worker
     * Loader isolate. The dispatch envelope is in a fresh isolate; the
     * actual command logic still uses the existing registry paths.
     *
     * Single-ownership: stdin/stdout/stderr returned as strings; no
     * shared buffers cross the RPC boundary.
     */
    async dispatchInline(req, kind) {
        if (kind === 'unknown') {
            return { exitCode: 127, stdout: '', stderr: `${req.command}: command not found\n` };
        }
        let stdoutBuf = '';
        let stderrBuf = '';
        const hooks = {
            onStdout: (d) => { stdoutBuf += d; },
            onStderr: (d) => { stderrBuf += d; },
        };
        const childEnv = {
            ...(req.env || {}),
        };
        if (kind === 'shell-direct') {
            if (typeof req.processPid !== 'number' || !Number.isInteger(req.processPid) || req.processPid <= 0) {
                return {
                    exitCode: 1,
                    stdout: '',
                    stderr: 'child_process: inline dispatch requires a broker-assigned process pid\n',
                };
            }
            try {
                const plan = this._shellPlanFor(req);
                if (!plan) {
                    return { exitCode: 127, stdout: '', stderr: `${req.command}: unsupported shell invocation\n` };
                }
                const stdin = typeof req.stdin === 'string' ? req.stdin : '';
                const commandLine = this._shellCommandLineForPlan(plan, String(req.cwd || '/home/user'), stdin, hooks, shellNameForCommand(req.command), req.processPid);
                if (commandLine === null)
                    return { exitCode: 127, stdout: stdoutBuf, stderr: stderrBuf };
                const code = await this._runShellLine(req.processPid, commandLine, childEnv, String(req.cwd || '/home/user'), stdin, hooks);
                return { exitCode: typeof code === 'number' ? code : 0, stdout: stdoutBuf, stderr: stderrBuf };
            }
            catch (e) {
                stderrBuf += `shell error: ${e?.message || String(e)}\n`;
                return { exitCode: 1, stdout: stdoutBuf, stderr: stderrBuf };
            }
        }
        if (kind === 'pure-builtin') {
            if (typeof req.processPid !== 'number' || !Number.isInteger(req.processPid) || req.processPid <= 0) {
                return {
                    exitCode: 1,
                    stdout: '',
                    stderr: 'child_process: inline dispatch requires a broker-assigned process pid\n',
                };
            }
            try {
                const code = await this.deps.commandRegistry.runPureBuiltin(req.processPid, req.command, req.args, childEnv, String(req.cwd || '/home/user'), typeof req.stdin === 'string' ? req.stdin : '', hooks);
                return { exitCode: typeof code === 'number' ? code : 0, stdout: stdoutBuf, stderr: stderrBuf };
            }
            catch (e) {
                stderrBuf += `Error: ${e?.message || String(e)}\n`;
                return { exitCode: 1, stdout: stdoutBuf, stderr: stderrBuf };
            }
        }
        // facet-direct
        const payload = JSON.stringify({
            command: req.command,
            args: req.args,
            env: childEnv,
            cwd: String(req.cwd || '/home/user'),
            stdin: '',
            processPid: req.processPid,
        });
        try {
            const code = await this.deps.facetMgr.execStream(payload, 
            // facetName: synthetic identity so adapter callers that key off
            // it don't collide; not used by the inline path.
            { facetName: `cp-inline-${Date.now().toString(36)}`, cwd: req.cwd, env: childEnv, argv: req.args }, hooks);
            return { exitCode: typeof code === 'number' ? code : 0, stdout: stdoutBuf, stderr: stderrBuf };
        }
        catch (e) {
            stderrBuf += `facet error: ${e?.message || String(e)}\n`;
            return { exitCode: 1, stdout: stdoutBuf, stderr: stderrBuf };
        }
    }
    /**
     * Synchronously drain the stdin queue for a pure-builtin. Waits up to
     * 50ms for stdinClosed if data is still flowing. Pure-builtins block
     * on full stdin so we have to commit upfront — the parent should have
     * called stdinEnd() before the wait ticks expire.
     */
    async _waitForStdinEvent(child, waitMs) {
        if (child.stdinClosed)
            return;
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                const idx = child.stdinWaiters.indexOf(wrapped);
                if (idx >= 0)
                    child.stdinWaiters.splice(idx, 1);
                resolve();
            }, Math.max(0, waitMs));
            const wrapped = () => {
                clearTimeout(timer);
                resolve();
            };
            child.stdinWaiters.push(wrapped);
        });
    }
    async _drainStdinForBuiltin(child) {
        if (!child.stdinClosed && child.stdinChunks.length === 0) {
            await this._waitForStdinEvent(child, STDIN_ATTACH_WAIT_MS);
        }
        if (!child.stdinClosed && child.stdinChunks.length > 0) {
            await this._waitForStdinEvent(child, STDIN_ATTACH_WAIT_MS);
        }
        return child.stdinChunks.join('');
    }
    _shellPlanFor(req) {
        const args = Array.isArray(req.args) ? req.args.map(String) : [];
        if (req.shell) {
            if (isShellCommand(req.command))
                return parseShellCommandArgs(req.command, args);
            return { kind: 'command', commandLine: shellLineFromSpawn(String(req.command), args), args: [] };
        }
        if (!isShellCommand(req.command))
            return null;
        return parseShellCommandArgs(req.command, args);
    }
    async _dispatchShell(child, req, hooks) {
        const plan = this._shellPlanFor(req);
        if (!plan) {
            this._appendOutput(child, 2, `${req.command}: unsupported shell invocation\n`);
            this._stampExit(child, 127, null);
            return;
        }
        try {
            const stdin = await this._drainStdinForShell(child);
            const commandLine = this._shellCommandLineForPlan(plan, req.cwd, stdin, hooks, shellNameForCommand(req.command), child.pid);
            if (commandLine === null) {
                this._stampExit(child, 127, null);
                return;
            }
            const code = await this._runShellLine(child.pid, commandLine, child.env, req.cwd, stdin, hooks);
            this._stampExit(child, typeof code === 'number' ? code : 0, null);
        }
        catch (e) {
            this._appendOutput(child, 2, `shell error: ${e?.message || String(e)}\n`);
            this._stampExit(child, 1, null);
        }
    }
    async _drainStdinForShell(child) {
        if (!child.stdinClosed && child.stdinChunks.length === 0) {
            await this._waitForStdinEvent(child, STDIN_ATTACH_WAIT_MS);
        }
        if (!child.stdinClosed && child.stdinChunks.length > 0) {
            await this._waitForStdinEvent(child, STDIN_ATTACH_WAIT_MS);
        }
        return child.stdinChunks.join('');
    }
    _shellCommandLineForPlan(plan, cwd, stdin, hooks, shellName, processPid) {
        if (plan.kind === 'command')
            return plan.commandLine;
        if (plan.kind === 'stdin')
            return stdin;
        const scriptPath = resolveVfsPath(plan.path, cwd || '/home/user');
        try {
            const vfs = this.deps.vfsForProcess(processPid);
            if (!vfs.exists(scriptPath) || vfs.isDirectory(scriptPath)) {
                hooks.onStderr(`${shellName}: ${plan.path}: No such file or directory\n`);
                return null;
            }
            return vfs.readFileString(scriptPath);
        }
        catch (e) {
            hooks.onStderr(`${shellName}: ${plan.path}: ${e?.message || String(e)}\n`);
            return null;
        }
    }
    async _runShellLine(pid, commandLine, env, cwd, stdin, hooks) {
        if (!this.deps.shellExecutor) {
            hooks.onStderr('sh: shell executor unavailable\n');
            return 127;
        }
        return this.deps.shellExecutor.execute(pid, commandLine, env, cwd || '/home/user', stdin, hooks);
    }
    // ── stdin queue ─────────────────────────────────────────────────────────
    stdinWrite(childPid, data) {
        const child = this.children.get(childPid);
        if (!child || child.stdinClosed || child.exitCode !== null)
            return { ok: false };
        if (child.stdinTotalBytes + data.length > STDIN_QUEUE_MAX_BYTES) {
            return { ok: false };
        }
        child.stdinChunks.push(data);
        child.stdinTotalBytes += data.length;
        // Flush any waiters
        for (const w of child.stdinWaiters.splice(0)) {
            w({ data, ended: false });
        }
        return { ok: true };
    }
    stdinEnd(childPid) {
        const child = this.children.get(childPid);
        if (!child)
            return;
        child.stdinClosed = true;
        for (const w of child.stdinWaiters.splice(0)) {
            w({ data: '', ended: true });
        }
    }
    /**
     * Long-poll: child facet asks the supervisor for its next stdin chunk.
     * Returns immediately if data is already queued OR if stdin is closed.
     */
    async cpReadStdin(childPid, waitMs) {
        const child = this.children.get(childPid);
        if (!child)
            return { data: '', ended: true };
        if (child.stdinChunks.length > 0) {
            const data = child.stdinChunks.shift();
            child.stdinTotalBytes -= data.length;
            return { data, ended: false };
        }
        if (child.stdinClosed)
            return { data: '', ended: true };
        // Long-poll
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const idx = child.stdinWaiters.indexOf(wrapped);
                if (idx >= 0)
                    child.stdinWaiters.splice(idx, 1);
                resolve({ data: '', ended: false });
            }, Math.min(waitMs, 5000));
            const wrapped = (r) => {
                clearTimeout(timer);
                resolve(r);
            };
            child.stdinWaiters.push(wrapped);
        });
    }
    // ── output queue ────────────────────────────────────────────────────────
    /** Internal: push a chunk to fd 1 or 2, fire log-store + waiters. */
    _appendOutput(child, fd, data) {
        if (!data)
            return;
        child.outputSeq[fd]++;
        const chunk = { seq: child.outputSeq[fd], data };
        child.outputs[fd].push(chunk);
        // Tee to the process supervisor's log ring for `logs <pid>` parity
        // with facet processes.
        try {
            this.deps.processes.appendOutput(child.pid, fd === 1 ? 'stdout' : 'stderr', data);
        }
        catch { /* ignore */ }
        // Resolve waiters whose fd matches and whose sinceSeq is now satisfied.
        for (let i = child.outputWaiters.length - 1; i >= 0; i--) {
            const w = child.outputWaiters[i];
            if (w.fd !== fd)
                continue;
            const fresh = child.outputs[fd].filter((c) => c.seq > w.sinceSeq);
            if (fresh.length > 0) {
                child.outputWaiters.splice(i, 1);
                w.resolve({
                    chunks: fresh,
                    closed: child.exitCode !== null,
                    maxSeq: child.outputSeq[fd],
                });
            }
        }
    }
    /**
     * Long-poll read for fd 1 or 2.  Returns immediately if there are
     * chunks > sinceSeq OR if the child has already exited.
     */
    async readOutput(childPid, fd, sinceSeq, waitMs = READ_OUTPUT_DEFAULT_WAIT_MS) {
        const child = this.children.get(childPid);
        if (!child) {
            return { chunks: [], closed: true, maxSeq: 0 };
        }
        const fresh = child.outputs[fd].filter((c) => c.seq > sinceSeq);
        if (fresh.length > 0 || child.exitCode !== null) {
            return {
                chunks: fresh,
                closed: child.exitCode !== null,
                maxSeq: child.outputSeq[fd],
            };
        }
        return new Promise((resolve) => {
            const expiresAt = Date.now() + Math.min(waitMs, 5000);
            const waiter = {
                fd,
                sinceSeq,
                resolve: (r) => {
                    clearTimeout(timer);
                    resolve(r);
                },
                expiresAt,
            };
            const timer = setTimeout(() => {
                const idx = child.outputWaiters.indexOf(waiter);
                if (idx >= 0)
                    child.outputWaiters.splice(idx, 1);
                // Re-snapshot at resolution time
                const fresh2 = child.outputs[fd].filter((c) => c.seq > sinceSeq);
                resolve({
                    chunks: fresh2,
                    closed: child.exitCode !== null,
                    maxSeq: child.outputSeq[fd],
                });
            }, expiresAt - Date.now());
            child.outputWaiters.push(waiter);
        });
    }
    /**
     * One-shot final flush. Used by the parent's exit-time drain (BLOCKER-1
     * fix in W8-plan §8.5). Returns ALL pending output for both fds plus
     * the closed state. Does NOT wait — caller is the parent shutting down.
     */
    async drainOutput(childPid) {
        const child = this.children.get(childPid);
        if (!child) {
            return { stdout: '', stderr: '', stdoutClosed: true, stderrClosed: true };
        }
        // Wait briefly (up to 50ms) for the dispatch to settle if the child
        // hasn't exited yet — without this, drain races against the spawn's
        // queueMicrotask in the test interpreter / real facet startup.
        const t0 = Date.now();
        while (child.exitCode === null && Date.now() - t0 < 100) {
            await new Promise((r) => setTimeout(r, 5));
        }
        return {
            stdout: child.outputs[1].map((c) => c.data).join(''),
            stderr: child.outputs[2].map((c) => c.data).join(''),
            stdoutClosed: child.exitCode !== null,
            stderrClosed: child.exitCode !== null,
        };
    }
    // ── kill / wait / reportExit ────────────────────────────────────────────
    /**
     * Synchronous kill. First-writer-wins on exit slot. Resolves all
     * pending waiters BEFORE invoking facets.abort so cpWait/cpReadOutput
     * don't hang on a torn-down facet.
     */
    kill(childPid, signal = 'SIGTERM') {
        const child = this.children.get(childPid);
        if (!child || child.exitCode !== null)
            return false;
        const exitCode = signal === 'SIGKILL' ? 137 : 143; // POSIX 128+9 / 128+15
        child.signal = signal;
        child.killed = true;
        // Stamp + wake waiters atomically.
        this._stampExit(child, exitCode, signal);
        // Tell the facet runtime to abort, best-effort. The mock FacetManager
        // and real FacetManager both expose an `abort(name)` method.
        try {
            if (this.deps.facetMgr.abort) {
                this.deps.facetMgr.abort(child.facetName, signal);
            }
            // Also try the ctx.facets path used by FacetManager.kill (for
            // production where facets are actual DO facets).
            if (this.deps.ctx?.facets?.abort) {
                this.deps.ctx.facets.abort(child.facetName, new Error(signal));
            }
        }
        catch { /* best-effort */ }
        // Defer delete by a microtask so any in-flight reportExit RPC lands
        // and is no-op'd by the idempotent guard in _stampExit.
        queueMicrotask(() => {
            try {
                if (this.deps.ctx?.facets?.delete) {
                    this.deps.ctx.facets.delete(child.facetName);
                }
            }
            catch { /* best-effort */ }
        });
        return true;
    }
    /**
     * Stamp the exit slot. Idempotent — first call wins.
     * Wakes all waiters (exit, output, stdin) so callers don't hang.
     */
    _stampExit(child, exitCode, signal) {
        if (child.exitCode !== null)
            return; // first writer wins
        child.exitCode = exitCode;
        child.signal = signal;
        child.endedAt = Date.now();
        // Tell the process supervisor so `ps` and `logs <pid>` line up.
        try {
            this.deps.processes.exit(child.pid, exitCode);
        }
        catch { }
        try {
            this.deps.processes.markExit(child.pid, exitCode);
        }
        catch { }
        // Wake exit waiters.
        for (const w of child.exitWaiters.splice(0)) {
            w({ done: true, exitCode, signal });
        }
        // Wake output waiters with closed=true so polling parents stop.
        for (const w of child.outputWaiters.splice(0)) {
            const fresh = child.outputs[w.fd].filter((c) => c.seq > w.sinceSeq);
            w.resolve({ chunks: fresh, closed: true, maxSeq: child.outputSeq[w.fd] });
        }
        // Wake stdin waiters with ended=true so a child blocked on cpReadStdin
        // unblocks and exits cleanly.
        for (const w of child.stdinWaiters.splice(0)) {
            w({ data: '', ended: true });
        }
    }
    /**
     * Late-arriving reportExit from the facet. Idempotent; if kill() or
     * an earlier reportExit already stamped, this is a no-op.
     */
    reportExit(childPid, exitCode, signal) {
        const child = this.children.get(childPid);
        if (!child)
            return;
        this._stampExit(child, exitCode, signal);
    }
    /**
     * Long-poll wait. Returns immediately if already exited; otherwise
     * registers a waiter that resolves on the next exit-slot stamp.
     */
    async wait(childPid, waitMs = WAIT_MAX_MS) {
        const child = this.children.get(childPid);
        if (!child) {
            return { done: true, exitCode: 1, signal: null };
        }
        if (child.exitCode !== null) {
            return { done: true, exitCode: child.exitCode, signal: child.signal };
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const idx = child.exitWaiters.indexOf(wrapped);
                if (idx >= 0)
                    child.exitWaiters.splice(idx, 1);
                resolve({ done: false, exitCode: null, signal: null });
            }, Math.min(waitMs, WAIT_MAX_MS));
            const wrapped = (r) => {
                clearTimeout(timer);
                resolve(r);
            };
            child.exitWaiters.push(wrapped);
        });
    }
    // ── housekeeping ────────────────────────────────────────────────────────
    /** Reap entries older than maxAgeMs whose exit slot is stamped. */
    reap(maxAgeMs = 60_000) {
        const now = Date.now();
        let n = 0;
        for (const [pid, child] of this.children) {
            if (child.exitCode !== null && child.endedAt && now - child.endedAt > maxAgeMs) {
                this.children.delete(pid);
                n++;
            }
        }
        return n;
    }
    get stats() {
        const all = [...this.children.values()];
        return {
            total: all.length,
            running: all.filter((c) => c.exitCode === null).length,
            exited: all.filter((c) => c.exitCode !== null && !c.killed).length,
            killed: all.filter((c) => c.killed).length,
        };
    }
    /** Test/diagnostic introspection. */
    _getChildEntry(pid) {
        return this.children.get(pid);
    }
}
