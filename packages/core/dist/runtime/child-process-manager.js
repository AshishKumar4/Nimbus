import { singleQuote } from '../_shared/shell-quote.js';
import { errorText } from '../_shared/error-text.js';
import { resolveVfsPath } from '../vfs/path.js';
import { parseShellInvocation } from '../shell/shell-invocation.js';
import { enc } from '../_shared/bytes.js';
import { exitCodeForSignal, parseSignalName, signalDisposition, signalOfStatus } from '../substrate/lifo/shell/signals.js';
import { pulledStdinReader } from '../shell/stdin-adapter.js';
import { parseProcessSignalName } from './process-io-protocol.js';
/** A text producer's edge onto the byte hooks. */
export function textBytes(text) {
    return enc.encode(text);
}
function concatBytes(chunks) {
    let total = 0;
    for (const c of chunks)
        total += c.byteLength;
    const joined = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
        joined.set(c, at);
        at += c.byteLength;
    }
    return joined;
}
/** The host's adapters as calls on the host: a class or prototype adapter keeps its methods and their receiver. */
function adapters(host, processes) {
    return {
        processes,
        resolve: (request, origin) => host.resolve(request, origin),
        terminate: (pid, signal) => host.terminate(pid, signal),
        issueNews: parentPid => host.issueNews?.(parentPid) ?? 0,
    };
}
/** Cap recursion depth to defend against runaway spawn loops. */
export const CHILD_PROCESS_MAX_DEPTH = 8;
const EMPTY_BYTES = new Uint8Array(0);
/** A pipe holds its writer here until its reader acknowledges consumed chunks. */
export const CHILD_STDIO_QUEUE_MAX_BYTES = 256 * 1024;
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
/** A spawn's stdio as the parent's ChildProcess reads it (node-shims _normalizeStdio): a mode per descriptor. */
function normalizeStdio(stdio) {
    const mode = (v) => (v === 'ignore' || v === 'inherit' ? v : 'pipe');
    if (typeof stdio === 'string')
        return [mode(stdio), mode(stdio), mode(stdio)];
    if (!Array.isArray(stdio))
        return ['pipe', 'pipe', 'pipe'];
    return [mode(stdio[0]), mode(stdio[1]), mode(stdio[2])];
}
// A command is a file's name, every character its own: Node spawns ' node' as no program (ENOENT).
function basenameOfCommand(command) {
    const text = String(command || '');
    if (!text)
        return '';
    const slash = text.lastIndexOf('/');
    return slash >= 0 ? text.slice(slash + 1) : text;
}
function isShellCommand(command) {
    const base = basenameOfCommand(command);
    return base === 'sh' || base === 'bash';
}
export function normalizeChildCommand(command) {
    const text = String(command || '');
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
/** A spawn's word on its command line: bare when every character is plainly safe, else single-quoted. */
function quoteShellToken(value) {
    return /^[A-Za-z0-9_\-./:=]+$/.test(value) ? value : singleQuote(value);
}
function shellLineFromSpawn(command, args) {
    return [command, ...(Array.isArray(args) ? args : [])].map((part) => quoteShellToken(String(part))).join(' ');
}
function shellPlanFor(request) {
    const args = Array.isArray(request.args) ? request.args.map(String) : [];
    if (isShellCommand(request.command))
        return parseShellCommandArgs(request.command, args);
    return request.shell ? { kind: 'command', commandLine: shellLineFromSpawn(request.command, args), args: [] } : null;
}
/** Shell spawns share parsing and script/stdin loading across local and remote hosts. */
export function shellChildRunner(request, vfs, execute) {
    const plan = shellPlanFor(request);
    if (!plan)
        return null;
    return {
        async run(context) {
            context.onStarted();
            try {
                let commandLine;
                if (plan.kind === 'command')
                    commandLine = plan.commandLine;
                else if (plan.kind === 'stdin')
                    commandLine = await context.stdin.readAll();
                else {
                    const shellName = shellNameForCommand(request.command);
                    const scriptPath = '/' + resolveVfsPath(plan.path, context.cwd);
                    try {
                        if (!await vfs.exists(scriptPath) || await vfs.isDirectory(scriptPath)) {
                            context.output.onStderr(textBytes(`${shellName}: ${plan.path}: No such file or directory\n`));
                            return 127;
                        }
                        commandLine = await vfs.readFileString(scriptPath);
                    }
                    catch (error) {
                        context.output.onStderr(textBytes(`${shellName}: ${plan.path}: ${errorText(error)}\n`));
                        return 127;
                    }
                }
                return await execute({ ...context, env: { ...context.env, NIMBUS_CP_CHILD_PID: String(context.pid) } }, commandLine);
            }
            catch (error) {
                context.output.onStderr(textBytes(`shell error: ${errorText(error)}\n`));
                return 1;
            }
        },
    };
}
export class ChildProcessManager {
    children = new Map();
    deps;
    constructor(deps) {
        this.deps = adapters(deps, deps.processes);
    }
    /** Bind the platform's runner and cleanup to the workspace's existing broker. */
    bindHost(host) {
        this.deps = adapters(host, this.deps.processes);
    }
    // ── spawn ───────────────────────────────────────────────────────────────
    /**
     * Allocate a child PID, classify the command, dispatch it to its runner.
     * Returns immediately with the child PID; the actual command executes
     * asynchronously, beside any other child, and pushes output via the
     * per-child hooks.
     */
    async spawn(req) {
        // Recursion-depth cap (env-propagated).
        const depthIn = parseInt(req.env?.NIMBUS_CP_DEPTH || '0', 10) || 0;
        if (depthIn >= CHILD_PROCESS_MAX_DEPTH) {
            // A spawn at a process limit: the parent's ChildProcess reports it as
            // Node does (code and errno ride across RPC).
            throw Object.assign(new Error(`EAGAIN: child_process spawn depth ${depthIn} exceeds ` +
                `CHILD_PROCESS_MAX_DEPTH=${CHILD_PROCESS_MAX_DEPTH}`), { code: 'EAGAIN', errno: -11 });
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
        const child = {
            pid,
            parentPid: req.parentPid,
            holders: Object.freeze(this.deps.processes.lineage(req.parentPid)),
            stdio: normalizeStdio(req.stdio),
            command: req.command,
            args: req.args || [],
            cwd: req.cwd,
            env: childEnv,
            startedAt: Date.now(),
            endedAt: null,
            outputs: { 1: [], 2: [] },
            outputSeq: { 1: 0, 2: 0 },
            outputBytes: { 1: 0, 2: 0 },
            outputDrained: [],
            outputWrites: { 1: Promise.resolve(), 2: Promise.resolve() },
            outputClosed: { 1: false, 2: false },
            parentClosed: null,
            outputWaiters: [],
            exitCode: null,
            signal: null,
            killed: false,
            spawnError: null,
            started: false,
            startWaiters: [],
            startNews: 0,
            exitNews: 0,
            closedNews: { 1: 0, 2: 0 },
            exitWaiters: [],
        };
        this.children.set(pid, child);
        child.parentClosed = this.deps.processes.subscribeTerminal(req.parentPid, () => {
            if (child.exitCode === null)
                this.kill(pid, 'SIGTERM');
        });
        // Every child kind owns an fd onto the same input store. Runners in
        // this isolate consume it through _stdinOf; facets through cpReadStdin.
        if (child.stdio[0] === 'inherit')
            this.deps.processes.inheritInput(pid, req.parentPid);
        else
            this.deps.processes.openInput(pid);
        if (child.stdio[0] === 'ignore')
            this.deps.processes.endInput(pid);
        const dispatchReq = shellPlanFor(req) ? req : { ...req, command: normalizeChildCommand(req.command) };
        let runner;
        try {
            // As the program named it: a host normalizes for its own lookup, a delegate's machine is handed the file.
            runner = await this.deps.resolve(req, { pid, cwd: req.cwd, env: childEnv });
            if (!runner)
                throw Object.assign(new Error(`spawn ${req.command} ENOENT`), { code: 'ENOENT', errno: -2, path: req.command });
        }
        catch (error) {
            this.deps.processes.closeInput(pid);
            child.parentClosed?.();
            this.children.delete(pid);
            this.deps.processes.exit(pid, 127);
            throw error;
        }
        // Dispatch after the cpSpawn RPC has had a chance to return
        // to the parent facet. That lets immediate child.stdin.write();
        // child.stdin.end() calls land in the stdin queue before a preseeded
        // child runtime starts. Resolution already succeeded before publishing
        // the child: an absent program is a spawn ENOENT, not an exit 127.
        const resolved = runner;
        setTimeout(() => { void this._dispatch(child, resolved, dispatchReq); }, 0);
        return { childPid: pid };
    }
    async _dispatch(child, runner, req) {
        if (child.exitCode !== null)
            return;
        const onStarted = () => this._markStarted(child);
        const hooks = {
            onStdout: (d) => this._appendOutput(child, 1, d),
            onStderr: (d) => this._appendOutput(child, 2, d),
            onStarted,
        };
        try {
            const result = await runner.run({
                pid: child.pid, parentPid: child.parentPid,
                command: req.command, args: req.args, cwd: String(req.cwd || '/home/user'),
                env: { ...child.env }, stdio: child.stdio,
                stdin: this._stdinOf(child), output: hooks, onStarted,
            });
            if (this._stampKilled(child))
                return;
            if (typeof result === 'number') {
                this._stampExit(child, result, null);
            }
            else if ('signal' in result) {
                if (result.signal === null)
                    this._stampExit(child, result.code, null);
                else
                    this._stampExit(child, exitCodeForSignal(result.signal.replace(/^SIG/, '')), result.signal);
            }
            else if (!child.started) {
                child.spawnError = result.code;
                this._stampExit(child, result.errno, null);
            }
            else {
                this._appendText(child, 2, `Error: ${result.code}\n`);
                this._stampExit(child, 1, null);
            }
        }
        catch (error) {
            if (this._stampKilled(child))
                return;
            this._appendText(child, 2, `Error: ${errorText(error)}\n`);
            this._stampExit(child, 1, null);
        }
    }
    /**
     * A child the process table ended with a signal (its process group's, a
     * `kill <pid>`), not through this broker: it died of that signal, whatever
     * its run returned as it was stopped. Whether it was.
     */
    _stampKilled(child) {
        const entry = this.deps.processes.get(child.pid);
        if (entry?.state !== 'killed' || entry.exitCode === null)
            return false;
        const name = signalOfStatus(entry.exitCode);
        if (name === null)
            return false;
        this._stampExit(child, entry.exitCode, `SIG${name}`);
        return true;
    }
    /**
     * The child's stdin as a stream over its queue: each read takes what the
     * parent has written, waiting for it, and ends when the parent ends stdin
     * or the child exits. Nothing is read ahead of the command's own reads.
     */
    _stdinOf(child) {
        return pulledStdinReader(async () => {
            for (;;) {
                const packet = await this.cpReadStdin(child.pid, 5000);
                if (packet.data.byteLength > 0)
                    return packet.data;
                if (packet.ended)
                    return null;
            }
        });
    }
    // ── stdin queue ─────────────────────────────────────────────────────────
    /** `writer`, the process writing, is interrupted by a signal it takes (SessionProcessSupervisor.writeInputBytesWait). */
    async stdinWrite(childPid, data, writer) {
        const child = this.children.get(childPid);
        if (!child || child.exitCode !== null)
            return { ok: false };
        return this.deps.processes.writeInputBytesWait(childPid, data, writer);
    }
    async stdinEnd(childPid) {
        const child = this.children.get(childPid);
        if (!child)
            return;
        await this.deps.processes.endInputAfterWrites(childPid);
    }
    /**
     * Put stdin the child took back in front of its queue, as it was, past the
     * queue's cap and after its end too: a run of the child that stopped
     * before using it, run again (runtime/stop-replay.ts).
     */
    unreadStdin(childPid, chunks) {
        const child = this.children.get(childPid);
        if (!child || chunks.length === 0)
            return;
        this.deps.processes.unreadInput(childPid, chunks.map(data => ({ data, ended: false })));
    }
    /**
     * Long-poll: child facet asks the supervisor for its next stdin chunk.
     * Returns immediately if data is already queued OR if stdin is closed.
     */
    async cpReadStdin(childPid, waitMs, maxBytes) {
        const packet = await this.deps.processes.readInput(childPid, waitMs, maxBytes);
        return { ...packet, data: typeof packet.data === 'string' ? textBytes(packet.data) : packet.data };
    }
    /** The next signal sent to `pid`, whose program takes its own (SessionProcessSupervisor.nextSignal). */
    nextSignal(pid, waitMs) {
        return this.deps.processes.nextSignal(pid, waitMs);
    }
    // ── output queue ────────────────────────────────────────────────────────
    /** A broker-side text message onto the child's byte ring. */
    _appendText(child, fd, text) {
        this._appendOutput(child, fd, textBytes(text));
    }
    /** Whether this pid's descriptors belong to a child managed by this broker. */
    isChild(pid) { return this.children.has(pid); }
    /**
     * Whether child `pid`'s handle is `caller`'s: `caller` spawned it, or is
     * above the process that did, as the spawn found them. It holds as long as
     * the broker holds the child's output and exit, whatever rows the process
     * table has forgotten since. False for a pid this broker did not spawn.
     */
    isHeldBy(pid, caller) { return this.children.get(pid)?.holders.includes(caller) === true; }
    /** Whether this pid is a child of this broker that has not ended. */
    isRunning(pid) { return this.children.get(pid)?.exitCode === null; }
    /** Runtime stdout/stderr for a broker-owned pid goes to its parent, not the shell. */
    routeOutput(pid, fd, bytes) {
        const child = this.children.get(pid);
        if (!child)
            return null;
        return child.exitCode === null ? this._appendOutput(child, fd, bytes) : Promise.resolve();
    }
    /** Internal: push a chunk to fd 1 or 2, fire log-store + waiters. */
    _appendOutput(child, fd, data) {
        // The child has ended, or its parent closed this read end: a write to a pipe with no reader.
        const readerGone = () => {
            if (child.exitCode !== null || child.outputClosed[fd])
                throw Object.assign(new Error('EPIPE: child output reader is gone'), { code: 'EPIPE' });
        };
        const task = child.outputWrites[fd].then(async () => {
            if (child.stdio[fd] === 'ignore')
                return;
            for (let at = 0; at < data.byteLength; at += CHILD_STDIO_QUEUE_MAX_BYTES) {
                const piece = data.subarray(at, Math.min(data.byteLength, at + CHILD_STDIO_QUEUE_MAX_BYTES));
                while (child.outputBytes[fd] + piece.byteLength > CHILD_STDIO_QUEUE_MAX_BYTES) {
                    readerGone();
                    await new Promise(resolve => child.outputDrained.push(resolve));
                }
                await this.deps.processes.releaseOutput(child.pid, () => {
                    readerGone();
                    this._pushOutput(child, fd, piece);
                });
            }
        });
        child.outputWrites[fd] = task.catch(() => { });
        return task;
    }
    _pushOutput(child, fd, data) {
        if (data.byteLength === 0)
            return;
        child.outputSeq[fd]++;
        const news = child.stdio[fd] !== 'ignore' ? this._news(child) : 0;
        const chunk = { seq: child.outputSeq[fd], data, news };
        child.outputs[fd].push(chunk);
        child.outputBytes[fd] += data.byteLength;
        // Tee to the process supervisor's log ring for `logs <pid>` parity
        // with facet processes; the ring decodes at its own edge.
        try {
            this.deps.processes.appendOutputBytes(child.pid, fd === 1 ? 'stdout' : 'stderr', data);
        }
        catch { /* ignore */ }
        // Resolve waiters whose fd matches and whose sinceSeq is now satisfied.
        for (let i = child.outputWaiters.length - 1; i >= 0; i--) {
            const w = child.outputWaiters[i];
            if (w.fd !== fd)
                continue;
            if (child.outputs[fd].some((c) => c.seq > w.sinceSeq)) {
                child.outputWaiters.splice(i, 1);
                w.resolve(this._readResult(child, fd, w.sinceSeq));
            }
        }
    }
    /**
     * A read's answer: the chunks past `sinceSeq`, whether the stream has
     * ended, and the parent's news it delivers: each chunk's, the child's
     * start (its output says it started), and the stream's end.
     */
    _readResult(child, fd, sinceSeq) {
        const fresh = child.outputs[fd].filter((c) => c.seq > sinceSeq);
        const closed = this._ended(child);
        const news = fresh.map((c) => c.news);
        if (fresh.length > 0)
            news.push(child.startNews);
        if (closed)
            news.push(child.closedNews[fd]);
        const numbers = news.filter((n) => n > 0);
        return {
            chunks: fresh.map(({ seq, data }) => ({ seq, data })),
            closed,
            maxSeq: child.outputSeq[fd],
            ...(numbers.length > 0 ? { news: numbers } : {}),
        };
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
        // The next cursor acknowledges exactly what its reader consumed.
        const acknowledged = child.outputs[fd].filter(c => c.seq <= sinceSeq);
        if (acknowledged.length > 0) {
            child.outputs[fd] = child.outputs[fd].filter(c => c.seq > sinceSeq);
            for (const chunk of acknowledged)
                child.outputBytes[fd] -= chunk.data.byteLength;
            for (const wake of child.outputDrained.splice(0))
                wake();
        }
        if (this._ended(child) || child.outputs[fd].some((c) => c.seq > sinceSeq)) {
            return this._readResult(child, fd, sinceSeq);
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
                resolve(this._readResult(child, fd, sinceSeq));
            }, expiresAt - Date.now());
            child.outputWaiters.push(waiter);
        });
    }
    /**
     * The parent closed its read end of the child's fd 1 or 2 (a consumer
     * destroyed the stream): what is queued there goes, and the child's
     * writes there, those waiting for room and those to come, fail EPIPE, as a
     * write to a pipe whose reader has gone does.
     */
    closeOutput(childPid, fd) {
        const child = this.children.get(childPid);
        if (!child || child.outputClosed[fd])
            return;
        child.outputClosed[fd] = true;
        child.outputs[fd] = [];
        child.outputBytes[fd] = 0;
        for (const wake of child.outputDrained.splice(0))
            wake();
        for (let i = child.outputWaiters.length - 1; i >= 0; i--) {
            const waiter = child.outputWaiters[i];
            if (waiter.fd !== fd)
                continue;
            child.outputWaiters.splice(i, 1);
            waiter.resolve(this._readResult(child, fd, waiter.sinceSeq));
        }
    }
    /**
     * One-shot final flush. Used by the parent's exit-time drain (BLOCKER-1
     * fix in W8-plan §8.5). Returns ALL pending output for both fds plus
     * the closed state. Does NOT wait — caller is the parent shutting down.
     */
    async drainOutput(childPid) {
        const child = this.children.get(childPid);
        if (!child) {
            return { stdout: EMPTY_BYTES, stderr: EMPTY_BYTES, stdoutClosed: true, stderrClosed: true };
        }
        // Wait briefly (up to 50ms) for the dispatch to settle if the child
        // hasn't exited yet — without this, drain races against the spawn's
        // queueMicrotask in the test interpreter / real facet startup.
        const t0 = Date.now();
        while (!this._ended(child) && Date.now() - t0 < 100) {
            await new Promise((r) => setTimeout(r, 5));
        }
        const closed = this._ended(child);
        return {
            stdout: concatBytes(child.outputs[1].map((c) => c.data)),
            stderr: concatBytes(child.outputs[2].map((c) => c.data)),
            stdoutClosed: closed,
            stderrClosed: closed,
        };
    }
    // ── kill / wait / reportExit ────────────────────────────────────────────
    /**
     * End the host's work and clean its resources first: exit(), used by the
     * stamp, drops the terminator without running it. The first stamp wins.
     */
    kill(childPid, signal = 'SIGTERM') {
        const child = this.children.get(childPid);
        if (!child || child.exitCode !== null)
            return false;
        // A name with or without SIG, or a number. One whose default action
        // does not end a process (SIGCHLD, SIGSTOP), the probe 0, or a name no
        // signal has ends nothing here.
        const name = parseSignalName(String(signal));
        if (name === null || name === '0')
            return false;
        // One its program takes is its program's, whatever its default action: the child runs on.
        const sent = parseProcessSignalName(`SIG${name}`);
        if (sent !== null && this.deps.processes.deliverSignal(child.pid, sent))
            return true;
        if (signalDisposition(name) !== 'terminate')
            return false;
        child.killed = true;
        this.deps.terminate(child.pid, name);
        this._stampExit(child, exitCodeForSignal(name), `SIG${name}`); // 128+signo, as the shell reports it
        return true;
    }
    /**
     * Stamp the exit slot. Idempotent — first call wins. What the child held
     * is released now (the process table's lifecycle); its parent is told
     * once the end is published (_ended).
     */
    _stampExit(child, exitCode, signal, flushed = false) {
        if (child.exitCode !== null)
            return; // first writer wins
        // A command may issue writes without awaiting them. Its normal exit
        // waits for those bounded pipes; a kill cuts them off and wakes them.
        if (!flushed && signal === null) {
            void Promise.all([child.outputWrites[1], child.outputWrites[2]]).then(() => this._stampExit(child, exitCode, signal, true));
            return;
        }
        child.exitCode = exitCode;
        child.signal = signal;
        child.endedAt = Date.now();
        for (const wake of child.outputDrained.splice(0))
            wake();
        // Numbered before the process table hears of the exit, so the parent's
        // report is stale before its child is gone from the table. A refused
        // spawn's streams carry nothing: its parent ends them itself.
        child.exitNews = this._news(child);
        if (child.spawnError === null) {
            for (const fd of [1, 2])
                if (child.stdio[fd] !== 'ignore')
                    child.closedNews[fd] = this._news(child);
        }
        try {
            this.deps.processes.exit(child.pid, exitCode);
        }
        catch { }
        // After the end's publication, which exit() queued first.
        void this.deps.processes.releaseOutput(child.pid, () => this._announceExit(child));
    }
    /** Whether the child's end is published (SessionProcessSupervisor.endHeld): what wait and its streams report. */
    _ended(child) {
        return child.exitCode !== null && !this.deps.processes.endHeld(child.pid);
    }
    /** The child's published end, to its waiters: wakes all of them (exit, output, stdin) so callers don't hang. */
    _announceExit(child) {
        if (child.exitCode !== null) {
            try {
                this.deps.processes.markExit(child.pid, child.exitCode);
            }
            catch { }
        }
        // Wake exit waiters.
        const status = this._exitStatus(child);
        for (const w of child.exitWaiters.splice(0))
            w(status);
        // Wake output waiters with closed=true so polling parents stop.
        for (const w of child.outputWaiters.splice(0))
            w.resolve(this._readResult(child, w.fd, w.sinceSeq));
        this.deps.processes.closeInput(child.pid);
        child.parentClosed?.();
        child.parentClosed = null;
    }
    /** A stamped child's end, as Node reports it (ChildExitStatus), with the news it delivers. */
    _exitStatus(child) {
        const numbers = [child.startNews, child.exitNews].filter((n) => n > 0);
        const news = numbers.length > 0 ? { news: numbers } : {};
        if (child.spawnError !== null)
            return { done: true, exitCode: child.exitCode, signal: null, spawnError: child.spawnError, ...news };
        return { done: true, exitCode: child.signal === null ? child.exitCode : null, signal: child.signal, ...news };
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
    async wait(childPid, waitMs = WAIT_MAX_MS, knownStarted = true) {
        const child = this.children.get(childPid);
        if (!child) {
            return { done: true, exitCode: 1, signal: null };
        }
        if (this._ended(child))
            return this._exitStatus(child);
        // A caller that has not heard of the start (a parent's ChildProcess,
        // which emits 'spawn' on it) is told of it as soon as it comes.
        const startNews = () => ({
            done: false, exitCode: null, signal: null, started: true, ...(child.startNews > 0 ? { news: [child.startNews] } : {}),
        });
        if (!knownStarted && child.started)
            return startNews();
        return new Promise((resolve) => {
            const settle = (r) => {
                clearTimeout(timer);
                const at = child.exitWaiters.indexOf(onExit);
                if (at >= 0)
                    child.exitWaiters.splice(at, 1);
                const started = child.startWaiters.indexOf(onStart);
                if (started >= 0)
                    child.startWaiters.splice(started, 1);
                resolve(r);
            };
            const timer = setTimeout(() => settle({ done: false, exitCode: null, signal: null }), Math.min(waitMs, WAIT_MAX_MS));
            const onExit = (r) => settle(r);
            const onStart = () => { if (!this._ended(child))
                settle(startNews()); };
            child.exitWaiters.push(onExit);
            if (!knownStarted)
                child.startWaiters.push(onStart);
        });
    }
    /** The child has started (ChildEntry.started): wake whoever waits to hear of it. */
    _markStarted(child) {
        if (child.started)
            return;
        child.started = true;
        child.startNews = this._news(child);
        for (const w of child.startWaiters.splice(0))
            w();
    }
    /** A piece of news of `child` for its parent, numbered (ChildProcessManagerDeps.issueNews). */
    _news(child) {
        try {
            return this.deps.issueNews?.(child.parentPid) ?? 0;
        }
        catch {
            return 0;
        }
    }
    // ── housekeeping ────────────────────────────────────────────────────────
    /** Reap entries older than maxAgeMs whose end is published. */
    reap(maxAgeMs = 60_000) {
        const now = Date.now();
        let n = 0;
        for (const [pid, child] of this.children) {
            if (this._ended(child) && child.endedAt && now - child.endedAt > maxAgeMs) {
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
            running: all.filter((c) => !this._ended(c)).length,
            exited: all.filter((c) => this._ended(c) && !c.killed).length,
            killed: all.filter((c) => c.killed).length,
        };
    }
    /** Test/diagnostic introspection. */
    _getChildEntry(pid) {
        return this.children.get(pid);
    }
}
/** A facet's child-process capability. Its parent identity and stdin cannot be borrowed from another pid. */
export function createChildProcessSupervisor(manager, pid) {
    return {
        cpSpawn: (request) => manager.spawn({ ...request, parentPid: pid }),
        cpStdinWrite: (child, bytes) => manager.stdinWrite(child, bytes, pid),
        cpStdinEnd: (child) => manager.stdinEnd(child),
        cpReadOutput: (child, fd, sinceSeq, waitMs) => manager.readOutput(child, fd, sinceSeq, waitMs),
        cpWait: (child, waitMs, _acquire, knownStarted = true) => manager.wait(child, waitMs, knownStarted),
        cpKill: (child, signal = 'SIGTERM') => manager.kill(child, signal),
        cpReadStdin: (_child, waitMs, _acquire, maxBytes) => manager.cpReadStdin(pid, waitMs, maxBytes),
        cpCloseOutput: (child, fd) => manager.closeOutput(child, fd),
        cpDrainOutput: (child) => manager.drainOutput(child),
        cpNextSignal: (waitMs) => manager.nextSignal(pid, waitMs),
    };
}
