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

import type { ProcessTable } from '../runtime/process-table.js';

/**
 * Result of running a pure-builtin or facet-direct command. Mirrors
 * FacetExecResult but with the streaming hooks already invoked, so this
 * value is just the final exit code.
 */
export interface ExecStreamResult {
  exitCode: number;
}

/**
 * Output chunk in a child's per-fd ring. Sequence numbers let parents
 * read incrementally with cpReadOutput(sinceSeq).
 */
interface OutputChunk {
  seq: number;
  data: string;
}

/**
 * Per-child mutable state. Created on spawn, torn down only when the
 * parent reaps via cpReap or after a configurable idle timeout (we leave
 * the entry around for late drain/wait calls).
 */
interface ChildEntry {
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  facetName: string;            // 'cp-proc-${pid}' — used by abort/delete
  startedAt: number;
  endedAt: number | null;

  // stdin queue (parent → child)
  stdinChunks: string[];
  stdinClosed: boolean;
  stdinTotalBytes: number;
  stdinWaiters: Array<(r: { data: string; ended: boolean }) => void>;

  // stdout/stderr ring (child → parent)
  // fd 1 = stdout, fd 2 = stderr.
  outputs: {
    1: OutputChunk[];
    2: OutputChunk[];
  };
  outputSeq: { 1: number; 2: number };
  outputWaiters: Array<{ fd: 1 | 2; sinceSeq: number; resolve: (r: ReadOutputResult) => void; expiresAt: number }>;

  // Exit slot (first-writer-wins)
  exitCode: number | null;
  signal: string | null;
  killed: boolean;
  exitWaiters: Array<(r: { done: boolean; exitCode: number | null; signal: string | null }) => void>;

  // Liveness
  facetSlot: { abort?: () => void; killed?: boolean } | null;
}

export interface SpawnReq {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdio: ('pipe' | 'ignore' | 'inherit')[];
  detached?: boolean;
  shell?: boolean | string;
  /** Optional explicit parent PID for log routing. */
  parentPid?: number;
}

export interface ReadOutputResult {
  chunks: { seq: number; data: string }[];
  closed: boolean;
  maxSeq: number;
}

export interface DrainResult {
  stdout: string;
  stderr: string;
  stdoutClosed: boolean;
  stderrClosed: boolean;
}

/**
 * Hooks invoked by the inline runner / facet-direct runner to push
 * output back into the per-child ring. Kept as a small structural type
 * so tests can supply mocks.
 */
export interface OutputHooks {
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
}

/**
 * Command resolution. The shell registry returns whatever shape it likes;
 * we adapt to a normalized 3-state result.
 */
export type CommandKind = 'pure-builtin' | 'facet-direct' | 'unknown';

/**
 * The minimum shape we need from the FacetManager. Production passes
 * the real FacetManager; tests pass a mock with execStream.
 */
export interface FacetManagerLike {
  execStream(
    code: string,
    opts: { facetName?: string; cwd?: string; env?: Record<string, string>; argv?: string[] },
    hooks: OutputHooks,
  ): Promise<number>;
  abort?(facetName: string, signal?: string): boolean;
}

/**
 * The minimum shape we need from the command registry.
 */
export interface CommandRegistryLike {
  resolve(name: string): { kind: CommandKind } | null;
  runPureBuiltin(
    name: string,
    args: string[],
    env: Record<string, string>,
    cwd: string,
    stdin: string,
    hooks: OutputHooks,
  ): Promise<number>;
}

/**
 * The minimum shape we need from the ProcessLogStore.
 */
export interface LogStoreLike {
  append(pid: number, stream: 'stdout' | 'stderr', data: string): void;
  markExit(pid: number, code: number): void;
  getExit(pid: number): number | undefined;
}

/**
 * Constructor deps bundle. Keeping it as a single object simplifies
 * tests AND makes the production wiring in nimbus-session.ts read
 * declaratively.
 */
export interface FacetProcessManagerDeps {
  facetMgr: FacetManagerLike;
  processTable: ProcessTable | { spawn: (cmd: string, argv: string[], cwd: string) => any; exit: (pid: number, code: number) => void; kill: (pid: number) => boolean; get: (pid: number) => any; reap: () => number };
  processLogs: LogStoreLike;
  vfs: { exists(p: string): boolean; readFileString(p: string): string; isDirectory(p: string): boolean };
  commandRegistry: CommandRegistryLike;
  /** Optional: ctx for facets.abort/delete in production. */
  ctx?: { facets?: { abort?: (name: string, e?: any) => void; delete?: (name: string) => void } };
}

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
  private children = new Map<number, ChildEntry>();
  private nextPid = 10_000; // child PIDs start above ProcessTable's range
  private deps: FacetProcessManagerDeps;

  constructor(deps: FacetProcessManagerDeps) {
    this.deps = deps;
  }

  // ── spawn ───────────────────────────────────────────────────────────────

  /**
   * Allocate a child PID, classify the command, dispatch to inline runner
   * or facet-direct runner. Returns immediately with the child PID; the
   * actual command executes asynchronously and pushes output via the
   * per-child hooks.
   */
  async spawn(req: SpawnReq): Promise<{ childPid: number }> {
    // Recursion-depth cap (env-propagated).
    const depthIn = parseInt(req.env?.NIMBUS_CP_DEPTH || '0', 10) || 0;
    if (depthIn >= CHILD_PROCESS_MAX_DEPTH) {
      throw new Error(
        `EAGAIN: child_process spawn depth ${depthIn} exceeds ` +
        `CHILD_PROCESS_MAX_DEPTH=${CHILD_PROCESS_MAX_DEPTH}`,
      );
    }
    const childEnv: Record<string, string> = {
      ...req.env,
      NIMBUS_CP_DEPTH: String(depthIn + 1),
    };

    const pid = this.nextPid++;
    const facetName = `cp-proc-${pid}`;
    const child: ChildEntry = {
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
    } catch { /* ignore */ }

    // Resolve command kind. Resolution failure → exit 127 (command not
    // found), no facet at all. Same shell semantics.
    const reg = this.deps.commandRegistry.resolve(req.command);
    const kind: CommandKind = reg ? reg.kind : 'unknown';

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
  private async _dispatch(child: ChildEntry, kind: CommandKind, req: SpawnReq): Promise<void> {
    if (kind === 'unknown') {
      this._appendOutput(child, 2, `${req.command}: command not found\n`);
      this._stampExit(child, 127, null);
      return;
    }
    const hooks: OutputHooks = {
      onStdout: (d) => this._appendOutput(child, 1, d),
      onStderr: (d) => this._appendOutput(child, 2, d),
    };
    if (kind === 'pure-builtin') {
      // Drain stdin synchronously — pure builtins are sync-style; they
      // expect a complete stdin string. The parent must call stdinEnd()
      // before this resolves. If the parent hasn't ended, we wait up to
      // 50ms for stdin then proceed with whatever's queued.
      const stdin = await this._drainStdinForBuiltin(child);
      try {
        const code = await this.deps.commandRegistry.runPureBuiltin(
          req.command, req.args, child.env, req.cwd, stdin, hooks,
        );
        this._stampExit(child, code, null);
      } catch (e: any) {
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
      stdin: '',  // facet-direct reads stdin via cpReadStdin RPC at runtime
    });
    // Register the facet-slot so kill() can find the abort handle.
    child.facetSlot = { abort: undefined, killed: false };
    try {
      const code = await this.deps.facetMgr.execStream(
        payload,
        { facetName: child.facetName, cwd: req.cwd, env: child.env, argv: req.args },
        hooks,
      );
      this._stampExit(child, code, null);
    } catch (e: any) {
      this._appendOutput(child, 2, `facet error: ${e?.message || String(e)}\n`);
      this._stampExit(child, 1, null);
    }
  }

  /**
   * Synchronously drain the stdin queue for a pure-builtin. Waits up to
   * 50ms for stdinClosed if data is still flowing. Pure-builtins block
   * on full stdin so we have to commit upfront — the parent should have
   * called stdinEnd() before the wait ticks expire.
   */
  private async _drainStdinForBuiltin(child: ChildEntry): Promise<string> {
    const t0 = Date.now();
    while (!child.stdinClosed && Date.now() - t0 < 50) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return child.stdinChunks.join('');
  }

  // ── stdin queue ─────────────────────────────────────────────────────────

  stdinWrite(childPid: number, data: string): { ok: boolean } {
    const child = this.children.get(childPid);
    if (!child || child.stdinClosed || child.exitCode !== null) return { ok: false };
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

  stdinEnd(childPid: number): void {
    const child = this.children.get(childPid);
    if (!child) return;
    child.stdinClosed = true;
    for (const w of child.stdinWaiters.splice(0)) {
      w({ data: '', ended: true });
    }
  }

  /**
   * Long-poll: child facet asks the supervisor for its next stdin chunk.
   * Returns immediately if data is already queued OR if stdin is closed.
   */
  async cpReadStdin(childPid: number, waitMs: number): Promise<{ data: string; ended: boolean }> {
    const child = this.children.get(childPid);
    if (!child) return { data: '', ended: true };
    if (child.stdinChunks.length > 0) {
      const data = child.stdinChunks.shift()!;
      child.stdinTotalBytes -= data.length;
      return { data, ended: false };
    }
    if (child.stdinClosed) return { data: '', ended: true };
    // Long-poll
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = child.stdinWaiters.indexOf(wrapped);
        if (idx >= 0) child.stdinWaiters.splice(idx, 1);
        resolve({ data: '', ended: false });
      }, Math.min(waitMs, 5000));
      const wrapped = (r: { data: string; ended: boolean }) => {
        clearTimeout(timer);
        resolve(r);
      };
      child.stdinWaiters.push(wrapped);
    });
  }

  // ── output queue ────────────────────────────────────────────────────────

  /** Internal: push a chunk to fd 1 or 2, fire log-store + waiters. */
  private _appendOutput(child: ChildEntry, fd: 1 | 2, data: string): void {
    if (!data) return;
    child.outputSeq[fd]++;
    const chunk: OutputChunk = { seq: child.outputSeq[fd], data };
    child.outputs[fd].push(chunk);
    // Tee to ProcessLogStore for `logs <pid>` parity with facet processes.
    try {
      this.deps.processLogs.append(child.pid, fd === 1 ? 'stdout' : 'stderr', data);
    } catch { /* ignore */ }
    // Resolve waiters whose fd matches and whose sinceSeq is now satisfied.
    for (let i = child.outputWaiters.length - 1; i >= 0; i--) {
      const w = child.outputWaiters[i];
      if (w.fd !== fd) continue;
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
  async readOutput(
    childPid: number,
    fd: 1 | 2,
    sinceSeq: number,
    waitMs: number = READ_OUTPUT_DEFAULT_WAIT_MS,
  ): Promise<ReadOutputResult> {
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
    return new Promise<ReadOutputResult>((resolve) => {
      const expiresAt = Date.now() + Math.min(waitMs, 5000);
      const waiter = {
        fd,
        sinceSeq,
        resolve: (r: ReadOutputResult) => {
          clearTimeout(timer);
          resolve(r);
        },
        expiresAt,
      };
      const timer = setTimeout(() => {
        const idx = child.outputWaiters.indexOf(waiter);
        if (idx >= 0) child.outputWaiters.splice(idx, 1);
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
  async drainOutput(childPid: number): Promise<DrainResult> {
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
  kill(childPid: number, signal: string = 'SIGTERM'): boolean {
    const child = this.children.get(childPid);
    if (!child || child.exitCode !== null) return false;

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
    } catch { /* best-effort */ }

    // Defer delete by a microtask so any in-flight reportExit RPC lands
    // and is no-op'd by the idempotent guard in _stampExit.
    queueMicrotask(() => {
      try {
        if (this.deps.ctx?.facets?.delete) {
          this.deps.ctx.facets.delete(child.facetName);
        }
      } catch { /* best-effort */ }
    });

    return true;
  }

  /**
   * Stamp the exit slot. Idempotent — first call wins.
   * Wakes all waiters (exit, output, stdin) so callers don't hang.
   */
  private _stampExit(child: ChildEntry, exitCode: number, signal: string | null): void {
    if (child.exitCode !== null) return; // first writer wins
    child.exitCode = exitCode;
    child.signal = signal;
    child.endedAt = Date.now();

    // Tell the ProcessTable + LogStore so `ps` and `logs <pid>` line up.
    try { this.deps.processTable.exit(child.pid, exitCode); } catch {}
    try { this.deps.processLogs.markExit(child.pid, exitCode); } catch {}

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
  reportExit(childPid: number, exitCode: number, signal: string | null): void {
    const child = this.children.get(childPid);
    if (!child) return;
    this._stampExit(child, exitCode, signal);
  }

  /**
   * Long-poll wait. Returns immediately if already exited; otherwise
   * registers a waiter that resolves on the next exit-slot stamp.
   */
  async wait(childPid: number, waitMs: number = WAIT_MAX_MS): Promise<{ done: boolean; exitCode: number | null; signal: string | null }> {
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
        if (idx >= 0) child.exitWaiters.splice(idx, 1);
        resolve({ done: false, exitCode: null, signal: null });
      }, Math.min(waitMs, WAIT_MAX_MS));
      const wrapped = (r: { done: boolean; exitCode: number | null; signal: string | null }) => {
        clearTimeout(timer);
        resolve(r);
      };
      child.exitWaiters.push(wrapped);
    });
  }

  // ── housekeeping ────────────────────────────────────────────────────────

  /** Reap entries older than maxAgeMs whose exit slot is stamped. */
  reap(maxAgeMs = 60_000): number {
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
  _getChildEntry(pid: number): ChildEntry | undefined {
    return this.children.get(pid);
  }
}
