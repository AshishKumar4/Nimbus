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

export interface ProcessSpawnOptions {
  /** Long-lived process (dev server, watcher, attached CLI). Surfaces a process tab. */
  longRunning?: boolean;
  /** Output and stdin are owned by an attached process terminal, not the parent shell. */
  attachedTty?: boolean;
  /** Inherit the parent process credential, including its current umask. */
  parentPid?: number;
  /** Explicit credential for a deliberate identity transition such as sudo. */
  cred?: VfsCred;
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

export class SessionProcessSupervisor {
  private readonly table = new ProcessTable();
  private readonly input = new ProcessInputStore();
  private logs = new ProcessLogStore();
  /** Fires after every appendOutput/markExit once log persistence is wired. */
  private logActivity: (() => void) | null = null;

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

  get(pid: number): ProcessEntry | undefined {
    return this.table.get(pid);
  }

  getRunning(): ProcessEntry[] {
    return this.table.getRunning();
  }

  getAll(): ProcessEntry[] {
    return this.table.getAll();
  }

  cred(pid: number): VfsCred {
    return this.table.credOf(pid);
  }

  setUmask(pid: number, umask: number): void {
    this.table.setUmask(pid, umask);
  }

  /** Mark a process as exited. First terminal state wins. */
  exit(pid: number, exitCode: number): void {
    this.table.exit(pid, exitCode);
  }

  /**
   * Mark a process as killed and tear down its input channel so queued
   * stdin can't outlive the process.
   */
  kill(pid: number): boolean {
    const killed = this.table.kill(pid);
    this.input.close(pid);
    return killed;
  }

  /** Clean up exited processes older than maxAge ms. */
  reap(maxAge?: number): number {
    return this.table.reap(maxAge);
  }

  get stats(): ProcessTable['stats'] {
    return this.table.stats;
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

  resize(pid: number, columns: number, rows: number): { ok: boolean } {
    return this.input.resize(pid, columns, rows);
  }

  signal(pid: number, signal: ProcessSignalName): { ok: boolean } {
    return this.input.signal(pid, signal);
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

  /** Record exit in the log store. Idempotent: the first record wins. */
  markExit(pid: number, code: number, reason?: string): void {
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
   * flushes without the store knowing about timers.
   */
  setLogPersist(adapter: PersistAdapter, onActivity: () => void): void {
    this.logs.setPersist(adapter);
    this.logActivity = onActivity;
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

  dropLogsOlderThan(ageMs?: number, isOrphan?: (pid: number) => boolean): number {
    return this.logs.dropOlderThan(ageMs, isOrphan);
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
  }
}
