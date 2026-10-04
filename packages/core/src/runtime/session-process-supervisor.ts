/**
 * SessionProcessSupervisor — the session's single process owner.
 *
 * Deep-module facade over the three process storage primitives:
 *
 *   - ProcessTable      — PID authority and lifecycle state.
 *   - ProcessInputStore — controlling-terminal input channel: stdin
 *     packets, resize (coalesced), signals, terminal size.
 *   - ProcessLogStore   — bounded output rings, exit records, and the
 *     SQL-backed hibernation persistence (W9).
 *
 * Every session-side caller — session routes, the programmatic SDK RPC
 * surface, agent tools, shell commands, npm-bin launches, the
 * child-process broker, and runtime runners — goes through this facade.
 * No caller touches the underlying stores directly.
 *
 * Stage 2 of the OS kernel plan (docs/architecture/nimbus-os-runtime-spec.md,
 * "Process And PTY Completion") extends this module with process groups,
 * raw/cooked terminal mode, and foreground-process-group signal policy.
 * `ProcessTerminalDescriptor` is the seam those land on.
 */

import { ProcessTable, type ProcessEntry } from './process-table.js';
import { ProcessInputStore, type ProcessInputPacket } from './process-input.js';
import {
  ProcessLogStore,
  type LogChunk,
  type LogStream,
  type PersistAdapter,
  type ProcessExitInfo,
  type ProcessLogReadOptions,
  type SequencedLogChunk,
} from './process-logs.js';
import type { ProcessSignalName } from './process-io-protocol.js';
import type { VfsCred } from './os-contracts.js';
import { StreamTextDecoders } from '../_shared/bytes.js';

export interface ProcessSpawnOptions {
  /** Long-lived process (dev server, watcher, attached CLI). Surfaces a process tab. */
  longRunning?: boolean;
  /** Output and stdin are owned by an attached process terminal, not the parent shell. */
  attachedTty?: boolean;
  /** Inherit the parent process credential, including its current umask, and its exec id. */
  parentPid?: number;
  /** Explicit credential for a deliberate identity transition such as sudo. */
  cred?: VfsCred;
  /** The exec id of a process that does not take its parent's (`ProcessEntry.execId`). */
  execId?: string;
}

/**
 * Controlling-terminal descriptor for a process with an open input
 * channel. Folds the `attachedTty` classification and the input
 * channel's terminal size into one typed view. Stage 2 adds raw/cooked
 * mode state and the foreground process group here.
 */
export interface ProcessTerminalDescriptor {
  pid: number;
  /** True when the process runs as an attached TTY-shaped process tab. */
  attached: boolean;
  columns: number;
  rows: number;
}

/** Signals whose default action terminates the process, by number. */
const DEFAULT_TERMINATING_SIGNALS: Partial<Record<ProcessSignalName, number>> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15,
};

export class SessionProcessSupervisor {
  private readonly table = new ProcessTable();
  private readonly input = new ProcessInputStore();
  private logs = new ProcessLogStore();
  /**
   * The log ring holds text lines; a process's output arrives as bytes. One
   * streaming decoder per (pid, stream) is this text consumer's edge, so a
   * character split across two chunks survives. Dropped at markExit.
   */
  private readonly outputDecoders = new StreamTextDecoders<string>();
  /** Terminators for processes whose work is a promise this session owns. */
  private terminators = new Map<number, () => void>();
  /** Fires after every appendOutput/markExit once log persistence is wired. */
  private logActivity: (() => void) | null = null;
  /** Fires when a log retention deadline may have appeared; see setLogPersist. */
  private logRetention: (() => void) | null = null;
  /** The orphan rule's "process is gone": this table no longer holds it. */
  private readonly isLogOrphan = (pid: number): boolean => !this.table.get(pid);
  /** Fires once per pid on its first terminal transition; see setOnTerminal. */
  private onTerminalCb: ((pid: number) => void) | null = null;
  /** Releases an ended process's filesystem binding; see setRelease. */
  private release: ((pid: number) => Promise<void>) | null = null;
  /** Ends a process by a signal's default action; see setDefaultSignalAction. */
  private defaultSignalAction: ((pid: number, code: number, signal: ProcessSignalName) => void) | null = null;

  // ── Lifecycle / PID authority ─────────────────────────────────────────

  /** Allocate a PID and register a new process. */
  spawn(command: string, argv: string[], cwd: string, opts: ProcessSpawnOptions = {}): ProcessEntry {
    const entry = this.table.spawn(command, argv, cwd, opts);
    if (opts.longRunning) this.table.setLongRunning(entry.pid);
    if (opts.attachedTty) this.table.setAttachedTty(entry.pid);
    return entry;
  }

  /** Mark an existing entry as long-running. Idempotent. */
  setLongRunning(pid: number): void {
    this.table.setLongRunning(pid);
  }

  /** Mark an existing entry as an attached terminal process. Idempotent. */
  setAttachedTty(pid: number): void {
    this.table.setAttachedTty(pid);
  }

  setForeground(pid: number, foreground: boolean): void {
    this.table.setForeground(pid, foreground);
  }

  get(pid: number): ProcessEntry | undefined {
    return this.table.get(pid);
  }

  getRunning(): ProcessEntry[] {
    return this.table.getRunning();
  }

  getAll(): ProcessEntry[] {
    return this.table.getAll();
  }

  /** Every process spawned under `pid`, transitively, oldest first. */
  descendantsOf(pid: number): ProcessEntry[] {
    return this.table.descendantsOf(pid);
  }

  /**
   * Register how to stop the work behind `pid`. Background jobs started
   * through the programmatic API run as a promise held by this session, so
   * `kill` has to abort them rather than only marking the table entry.
   * Cleared once the process reaches a terminal state.
   */
  setTerminator(pid: number, terminate: () => void): void {
    this.terminators.set(pid, terminate);
  }

  private terminate(pid: number): void {
    const terminator = this.terminators.get(pid);
    if (!terminator) return;
    this.terminators.delete(pid);
    try { terminator(); } catch { /* the process is going away regardless */ }
  }

  cred(pid: number): VfsCred {
    return this.table.credOf(pid);
  }

  setUmask(pid: number, umask: number): number {
    return this.table.setUmask(pid, umask);
  }

  /**
   * Observe every pid's FIRST transition out of `running`, whichever door it
   * leaves by — exit(), kill(), a facet's self-reported exit, a timeout abort:
   * all of them end here, which is what makes this one callback a complete
   * seam for per-pid durable state (the resident-launch journal) that must be
   * released exactly when the process ends and never before.
   *
   * One slot, owned by the FacetManager. A second subscriber would mean two
   * owners of process-end policy; grow this into a list only when a second
   * genuine owner exists.
   */
  setOnTerminal(cb: (pid: number) => void): void {
    this.onTerminalCb = cb;
  }

  private fireTerminal(pid: number, wasRunning: boolean): void {
    if (!wasRunning || !this.onTerminalCb) return;
    if (this.table.get(pid)?.state === 'running') return;
    try { this.onTerminalCb(pid); } catch { /* the process is gone regardless */ }
  }

  /** Mark a process as exited. First terminal state wins. */
  exit(pid: number, exitCode: number): void {
    const wasRunning = this.table.get(pid)?.state === 'running';
    this.table.exit(pid, exitCode);
    this.terminators.delete(pid);
    this.fireTerminal(pid, wasRunning);
  }

  /**
   * Mark a process as killed and tear down its input channel so queued
   * stdin can't outlive the process. `exitCode` is the ending signal's
   * status; SIGKILL's 137 when absent.
   */
  kill(pid: number, exitCode?: number): boolean {
    const wasRunning = this.table.get(pid)?.state === 'running';
    const killed = this.table.kill(pid, exitCode);
    this.terminate(pid);
    this.input.close(pid);
    this.fireTerminal(pid, wasRunning);
    return killed;
  }

  /**
   * Clean up exited processes older than maxAge ms, each released first (see
   * {@link setRelease}), as {@link reapTree} does: a session prunes its table
   * this way rather than at each call's return, and an entry forgotten
   * unreleased left its binding behind. With no release set nothing is
   * reaped. A reaped pid whose logs hold no exit (a process killed around its
   * log) is an orphan from here, which gives its logs a deadline.
   */
  async reap(maxAge?: number): Promise<number> {
    const release = this.release;
    if (!release) return 0;
    let reaped = 0;
    for (const entry of this.table.expired(maxAge)) {
      await release(entry.pid);
      this.table.forget(entry.pid);
      reaped++;
    }
    if (reaped > 0) this.logRetention?.();
    return reaped;
  }

  /**
   * How an ended process lets go of what it bound in the filesystem (its
   * descriptor scope, its watches): the `releaseProcess` of the filesystem
   * this table's processes bind to. One slot, set by the workspace composed
   * over this table, which owns that filesystem; {@link reapTree} calls it
   * for each entry before forgetting it.
   */
  setRelease(release: (pid: number) => Promise<void>): void {
    this.release = release;
  }

  /**
   * Remove `pid` and every process under it that has ended, now, as a parent
   * that waited for its children does: what a caller ran to completion has
   * nothing left to report. Each is released first (see {@link setRelease}),
   * so what it bound goes with its entry rather than outliving it; with no
   * release set this refuses. One still running is kept. Logs are
   * orphaned as by {@link reap}.
   */
  async reapTree(pid: number): Promise<number> {
    const release = this.release;
    if (!release) throw new Error('reapTree: this process table has no filesystem release; compose a workspace over it');
    let reaped = 0;
    for (const entry of [this.table.get(pid), ...this.table.descendantsOf(pid)]) {
      if (entry === undefined || entry.state === 'running') continue;
      await release(entry.pid);
      this.table.forget(entry.pid);
      reaped++;
    }
    if (reaped > 0) this.logRetention?.();
    return reaped;
  }

  get stats(): ProcessTable['stats'] {
    return this.table.stats;
  }

  /** See ProcessTable.residentRunning — running long-running process count. */
  get residentRunning(): number {
    return this.table.residentRunning;
  }

  /** See ProcessTable.setPidBase — generation-unique pid allocation. */
  setPidBase(base: number): void {
    this.table.setPidBase(base);
  }

  /** The current generation's pid floor: pids <= base are prior-generation. */
  get pidBase(): number {
    return this.table.pidBase;
  }

  // ── Controlling terminal / stdin ──────────────────────────────────────

  /** Open the process's input channel. Until opened, input writes fail. */
  openInput(pid: number): void {
    this.input.open(pid);
  }

  hasInput(pid: number): boolean {
    return this.input.has(pid);
  }

  writeInput(pid: number, data: string): { ok: boolean } {
    return this.input.write(pid, data);
  }

  /** Queue input bytes exactly as given (a pipe or redirect). */
  writeInputBytes(pid: number, data: Uint8Array): { ok: boolean; full?: boolean } {
    return this.input.writeBytes(pid, data);
  }

  /** Resolves when a write refused for a full queue may succeed; false once the channel is ended or gone. */
  whenInputWritable(pid: number): Promise<boolean> {
    return this.input.whenWritable(pid);
  }

  /** Signal stdin EOF. Queued packets still drain; further writes fail. */
  endInput(pid: number): void {
    this.input.end(pid);
  }

  /** End and drop the input channel entirely. */
  closeInput(pid: number): void {
    this.input.close(pid);
  }

  readInput(pid: number, waitMs?: number): Promise<ProcessInputPacket> {
    return this.input.read(pid, waitMs);
  }

  /** See ProcessInputStore.unread: input taken back to the front of the queue. */
  unreadInput(pid: number, packets: readonly ProcessInputPacket[]): void {
    this.input.unread(pid, packets);
  }

  resize(pid: number, columns: number, rows: number): { ok: boolean } {
    return this.input.resize(pid, columns, rows);
  }

  /**
   * Deliver a signal through the process's input channel. A process that has
   * not yet read that channel has not run far enough to install a handler,
   * so a terminating signal takes its default action now instead of waiting
   * in the queue for however long the program takes to start.
   */
  signal(pid: number, signal: ProcessSignalName): { ok: boolean } {
    const signo = DEFAULT_TERMINATING_SIGNALS[signal];
    const entry = this.table.get(pid);
    // Only an attached program reads its signals from this channel; a job
    // that never reads it is not "not yet started". SIGKILL cannot be caught,
    // blocked or ignored: it ends any running process at once, whether or not
    // the process reads this channel — a launch stuck before its first read
    // (a top-level await that never settles) or a background job that never
    // opens one was otherwise unkillable.
    const uncatchable = signal === 'SIGKILL';
    if (signo !== undefined && entry?.state === 'running'
      && (uncatchable || (entry.attachedTty === true && this.input.has(pid) && !this.input.hasReader(pid)))) {
      const code = 128 + signo;
      // Stop the work first: exit() drops the terminator without running it.
      this.terminate(pid);
      if (this.defaultSignalAction) {
        this.defaultSignalAction(pid, code, signal);
      } else {
        this.exit(pid, code);
        this.markExit(pid, code, signal);
        this.input.close(pid);
      }
      return { ok: true };
    }
    return this.input.signal(pid, signal);
  }

  /**
   * How a signal's default action ends a process whose work lives outside
   * this table (a facet being built or booted). One slot, owned by the
   * FacetManager, like setOnTerminal.
   */
  setDefaultSignalAction(cb: (pid: number, code: number, signal: ProcessSignalName) => void): void {
    this.defaultSignalAction = cb;
  }

  /** Controlling-terminal descriptor; null when no input channel is open. */
  terminal(pid: number): ProcessTerminalDescriptor | null {
    const size = this.input.terminalSize(pid);
    if (!size) return null;
    return {
      pid,
      attached: this.table.get(pid)?.attachedTty === true,
      columns: size.columns,
      rows: size.rows,
    };
  }

  // ── Output / exit records ─────────────────────────────────────────────

  appendOutput(pid: number, stream: LogStream, data: string): void {
    this.logs.append(pid, stream, data);
    this.logActivity?.();
  }

  /** A process's own output: bytes on the relay, decoded at this edge. */
  appendOutputBytes(pid: number, stream: LogStream, data: Uint8Array): void {
    const text = this.outputDecoders.decode(`${pid}:${stream}`, data);
    if (text.length > 0) this.appendOutput(pid, stream, text);
  }

  /** Record exit in the log store. Idempotent: the first record wins. */
  markExit(pid: number, code: number, reason?: string): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const tail = this.outputDecoders.drop(`${pid}:${stream}`);
      if (tail.length > 0) this.logs.append(pid, stream, tail);
    }
    this.logs.markExit(pid, code, reason);
    this.logActivity?.();
  }

  getExit(pid: number): ProcessExitInfo | null {
    return this.logs.getExit(pid);
  }

  hasLogs(pid: number): boolean {
    return this.logs.has(pid);
  }

  logSize(pid: number): number {
    return this.logs.size(pid);
  }

  readLogs(
    pid: number,
    opts?: ProcessLogReadOptions,
  ): { chunks: SequencedLogChunk[]; cursor: number; truncated: boolean } {
    return this.logs.read(pid, opts);
  }

  tailLogs(pid: number, opts?: Pick<ProcessLogReadOptions, 'lines' | 'bytes'>): LogChunk[] {
    return this.logs.tail(pid, opts);
  }

  allLogs(pid: number): LogChunk[] {
    return this.logs.all(pid);
  }

  /** See ProcessLogStore.buffered — a read that never hydrates from SQL. */
  bufferedLogs(pid: number): LogChunk[] {
    return this.logs.buffered(pid);
  }

  logSnapshot(pid: number): { bytes: number; chunks: number; exit: ProcessExitInfo | null } | null {
    return this.logs.snapshot(pid);
  }

  subscribeLogs(pid: number, cb: (chunk: LogChunk) => void): () => void {
    return this.logs.subscribe(pid, cb);
  }

  subscribeExit(pid: number, cb: (exit: ProcessExitInfo) => void): () => void {
    return this.logs.subscribeExit(pid, cb);
  }

  get logStats(): ProcessLogStore['stats'] {
    return this.logs.stats;
  }

  // ── Log persistence / hibernation (W9) ────────────────────────────────

  /**
   * Install the SQL-backed persistence adapter. `onActivity` fires after
   * every appendOutput/markExit so the host can schedule debounced
   * flushes without the store knowing about timers. `onRetention` fires
   * only when a retention deadline may have appeared — a pid's logs
   * begin, its exit is recorded, a reader leaves, or the table reaps — so
   * the host re-reads `nextLogExpiry` there and never per chunk.
   */
  setLogPersist(adapter: PersistAdapter, onActivity: () => void, onRetention?: () => void): void {
    this.logs.setPersist(adapter);
    this.logActivity = onActivity;
    this.logRetention = onRetention ?? null;
    this.logs.setRetentionHook(() => this.logRetention?.());
  }

  /**
   * Install the instance-level chunk/exit broadcast (the hibernation-safe
   * process-terminal WS fan-out — see ProcessLogStore.setBroadcast).
   */
  setLogBroadcast(
    onChunk: (pid: number, chunk: LogChunk) => void,
    onExit: (pid: number, exit: ProcessExitInfo) => void,
  ): void {
    this.logs.setBroadcast(onChunk, onExit);
  }

  flushLogs(): void {
    this.logs.flush();
  }

  /** Drop the logs that are due; a pid this table no longer holds counts as an orphan. */
  dropLogsOlderThan(ageMs?: number): number {
    return this.logs.dropOlderThan(ageMs, this.isLogOrphan);
  }

  /** When dropLogsOlderThan next has work, by the same orphan rule, or null. */
  nextLogExpiry(): number | null {
    return this.logs.nextExpiry(undefined, this.isLogOrphan);
  }

  logHibStats(): ReturnType<ProcessLogStore['hibStats']> {
    return this.logs.hibStats();
  }

  /**
   * Replace the in-memory log store with a fresh, unwired one. Test-only
   * hibernation simulation (`/api/_test/hib/simulate`): the caller must
   * re-wire persistence afterwards, mirroring a post-wake isolate.
   */
  resetLogStore(): void {
    this.logs = new ProcessLogStore();
    this.logActivity = null;
    this.logRetention = null;
  }
}
