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
/** Cap recursion depth to defend against runaway spawn loops. */
export const CHILD_PROCESS_MAX_DEPTH = 8;
/**
 * Cap stdin queue per child to avoid unbounded memory consumption from a
 * fast parent against a slow child. cpStdinWrite returns ok=false past
 * the cap; the parent's Writable will then surface a 'drain'-needed
 * signal (real Node would return false from .write).
 */
const STDIN_QUEUE_MAX_BYTES = 256 * 1024; // 256 KiB
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
export class FacetProcessManager {
    children = new Map();
    nextPid = 10_000; // child PIDs start above ProcessTable's range
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
        const pid = this.nextPid++;
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
        // ProcessTable side: register so `ps`/`logs` see the child.
        try {
            this.deps.processTable.spawn(`${req.command} ${req.args.join(' ')}`.trim(), req.args, req.cwd);
        }
        catch { /* ignore */ }
        // Resolve command kind. Resolution failure → exit 127 (command not
        // found), no facet at all. Same shell semantics.
        const reg = this.deps.commandRegistry.resolve(req.command);
        const kind = reg ? reg.kind : 'unknown';
        // Dispatch — fire-and-forget. The promise resolves when the command
        // completes, at which point we stamp the exit slot.
        void this._dispatch(child, kind, req).catch((e) => {
            // Last-resort: if both runners somehow throw, exit 1 with the error
            // on stderr.
            this._appendOutput(child, 2, `Error: ${e?.message || String(e)}\n`);
            this._stampExit(child, 1, null);
        });
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
        // child-process isolation gap #1: if a spawnPool is configured (production
        // wiring), route the dispatch through a fresh Worker Loader
        // isolate via NimbusFanoutPool. The pool's task body emits a
        // per-isolate marker token + delegates the actual command back
        // to the supervisor via env.SUPERVISOR.cpDispatchInline (preserves
        // pure-builtin / facet-direct correctness; only the dispatch
        // envelope moves to a fresh isolate).
        if (this.deps.spawnPool) {
            // Pure-builtins consume stdin; drain before dispatch. facet-direct
            // reads stdin lazily via cpReadStdin so we don't block on it here.
            const stdin = kind === 'pure-builtin'
                ? await this._drainStdinForBuiltin(child)
                : '';
            // Single-ownership: build a fresh request payload (not a reference
            // to the caller's req) at the boundary.
            const reqCopy = {
                command: String(req.command),
                args: Array.isArray(req.args) ? [...req.args] : [],
                env: { ...child.env },
                cwd: String(req.cwd),
                stdio: req.stdio,
                detached: !!req.detached,
                shell: req.shell ?? false,
                stdin,
            };
            // Register the facet-slot so kill() can find the abort handle.
            child.facetSlot = { abort: undefined, killed: false };
            try {
                const code = await this.deps.spawnPool.runOne(reqCopy, kind, hooks, child.pid);
                this._stampExit(child, code, null);
            }
            catch (e) {
                this._appendOutput(child, 2, `spawn-pool error: ${e?.message || String(e)}\n`);
                this._stampExit(child, 1, null);
            }
            return;
        }
        // ── Legacy in-supervisor dispatch (unit-test path) ─────────────
        if (kind === 'pure-builtin') {
            // Drain stdin synchronously — pure builtins are sync-style; they
            // expect a complete stdin string. The parent must call stdinEnd()
            // before this resolves. If the parent hasn't ended, we wait up to
            // 50ms for stdin then proceed with whatever's queued.
            const stdin = await this._drainStdinForBuiltin(child);
            try {
                const code = await this.deps.commandRegistry.runPureBuiltin(req.command, req.args, child.env, req.cwd, stdin, hooks);
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
            env: child.env,
            cwd: req.cwd,
            stdin: '', // facet-direct reads stdin via cpReadStdin RPC at runtime
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
        if (kind === 'pure-builtin') {
            try {
                const code = await this.deps.commandRegistry.runPureBuiltin(req.command, req.args, childEnv, String(req.cwd || '/home/user'), typeof req.stdin === 'string' ? req.stdin : '', hooks);
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
            stdin: typeof req.stdin === 'string' ? req.stdin : '',
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
    async _drainStdinForBuiltin(child) {
        const t0 = Date.now();
        while (!child.stdinClosed && Date.now() - t0 < 50) {
            await new Promise((r) => setTimeout(r, 5));
        }
        return child.stdinChunks.join('');
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
        // Tee to ProcessLogStore for `logs <pid>` parity with facet processes.
        try {
            this.deps.processLogs.append(child.pid, fd === 1 ? 'stdout' : 'stderr', data);
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
        // Tell the ProcessTable + LogStore so `ps` and `logs <pid>` line up.
        try {
            this.deps.processTable.exit(child.pid, exitCode);
        }
        catch { }
        try {
            this.deps.processLogs.markExit(child.pid, exitCode);
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
