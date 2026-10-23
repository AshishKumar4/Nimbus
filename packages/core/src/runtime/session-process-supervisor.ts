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

import { ProcessTable, type ProcessEntry, type ProcessRestart } from './process-table.js';
import { ProcessInputStore, type ProcessInputPacket } from './process-input.js';
import {
  ProcessLogStore,
  type LogChunk,
  type ByteLogChunk,
  type LogStream,
  type PersistAdapter,
  type ProcessExitInfo,
  type ProcessLogReadOptions,
  type SequencedLogChunk,
} from './process-logs.js';
import { parseProcessSignalName, type ProcessSignalName } from './process-io-protocol.js';
import type { OutputGate, ProcessOutput } from './output-gate.js';
import { exitCodeForSignal, parseSignalName, signalDisposition, type SignalAbortReason } from '../substrate/lifo/shell/signals.js';
import type { VfsCred } from './os-contracts.js';
import { DELEGATION_RECALL_TIMEOUT_MS } from './delegations.js';

export interface ProcessWorkObservation {
  release(): void;
}
export type HeldProcessWork = (() => void) & { readonly signal?: AbortSignal };

/**
 * How long work still held for an ended process (holdWork) has to stop: the
 * session's bound on a holder that does not let go when asked, the one a
 * delegation's recall has (delegations.ts). Past it the work is stopped
 * again and the process released all the same; work that ignored its stop
 * meets a closed scope.
 */
const HELD_WORK_STOP_MS = DELEGATION_RECALL_TIMEOUT_MS;

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
  /** The controlling terminal of a process that does not take its parent's (`ProcessEntry.terminal`): a terminal's shell. */
  terminal?: string;
  /** A shell's background job (`ProcessEntry.backgroundJob`). */
  backgroundJob?: boolean;
  /** The process this one restarts (`ProcessEntry.restartedFrom`). */
  restartedFrom?: ProcessRestart;
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

const ONCE = { once: true };
/** The longest one wait for a signal lasts (nextSignal): a guest's long poll asks again after it. */
const SIGNAL_WAIT_MAX_MS = 5000;
const signalWaitMs = (waitMs: number): number => Math.max(0, Math.min(waitMs, SIGNAL_WAIT_MAX_MS));
const NOTHING_REAPED: Promise<number> = Promise.resolve(0);

/** A process whose program takes its own signals: those it catches, those sent and not taken, and its one wait for the next. */
interface SignalBox {
  catches: ReadonlySet<ProcessSignalName>;
  readonly queued: ProcessSignalName[];
  taker: ((signal: ProcessSignalName | null) => void) | null;
  /**
   * Its program's run has stopped and the next has not taken over
   * (parkSignals): what it catches waits here, for the run that comes next.
   */
  parked: boolean;
  /**
   * The last signal its program was given, until it asks again: a run that
   * stopped before it acted on it gives it back. Each giving its own: who
   * gives one back takes it from here, and a later hand cannot give it again.
   */
  handed: { readonly signal: ProcessSignalName } | null;
}

/** Whether `a` and `b` are one identity: uid, gid and supplementary groups (as a set); a umask is not one. */
function sameIdentity(a: Readonly<VfsCred>, b: Readonly<VfsCred>): boolean {
  if (a === b) return true;
  if (a.uid !== b.uid || a.gid !== b.gid) return false;
  const groups = new Set(a.groups);
  return b.groups.every((gid) => groups.has(gid)) && new Set(b.groups).size === groups.size;
}

/**
 * Whether a process running as `from` may start `command` (its command line)
 * as `to`, a credential other than its own: the host's word on every identity
 * change (sudo, su, any command's runAs).
 */
export type IdentityChangePolicy = (from: Readonly<VfsCred>, to: Readonly<VfsCred>, command: string) => boolean;

export class SessionProcessSupervisor implements ProcessOutput {
  private readonly table = new ProcessTable();
  /** Why no process is admitted any more (closeAdmission); null while they are. */
  private refusal: Error | null = null;
  /** What every spawn as another identity asks first; see governIdentityChanges. */
  private identityPolicy: IdentityChangePolicy | null = null;
  private readonly input = new ProcessInputStore();
  private logs = new ProcessLogStore();

  /** Terminators for processes whose work is a promise this session owns. */
  private terminators = new Map<number, () => void>();
  /**
   * The processes whose programs take their own signals (takeSignals): the
   * signals sent to each that it has not taken, and its one wait for the next.
   */
  private readonly signalBoxes = new Map<number, SignalBox>();
  /** The work this session runs on each pid's own descriptors (holdWork): how to stop each piece, and whether it was. */
  private readonly held = new Map<number, Set<{ stop: (reason?: SignalAbortReason) => void; stopped: boolean; signal?: AbortSignal; observation?: ProcessWorkObservation }>>();
  private observeWork: ((pid: number) => ProcessWorkObservation) | null = null;
  /** Fires after every appendOutput/markExit once log persistence is wired. */
  private logActivity: (() => void) | null = null;
  /** Fires when a log retention deadline may have appeared; see setLogPersist. */
  private logRetention: (() => void) | null = null;
  /** The orphan rule's "process is gone": this table no longer holds it. */
  private readonly isLogOrphan = (pid: number): boolean => !this.table.get(pid);
  /** Fires once per pid on its first terminal transition; see setOnTerminal. */
  private onTerminalCb: ((pid: number) => void) | null = null;
  /** Per pid, what its first terminal transition tells; see subscribeTerminal. */
  private readonly terminalSubscribers = new Map<number, Set<() => void>>();
  /** Releases an ended process's filesystem binding; see setRelease. */
  private release: ((pid: number) => Promise<void>) | null = null;
  /** Tells that filesystem the process has ended, at its end; see setRelease. */
  private ended: ((pid: number) => void) | null = null;
  /** Each ended pid's release, begun at its end: what a prune reports and waits for before it forgets the entry. */
  private readonly releases = new Map<number, Promise<{ error: unknown } | null>>();
  /** Who waits for a pid's release to run (released), until it begins. */
  private readonly releaseWaiters = new Map<number, (() => void)[]>();
  /** Each ended pid whose held work is still stopping: the bound on it (HELD_WORK_STOP_MS). */
  private readonly stopBounds = new Map<number, ReturnType<typeof setTimeout>>();
  /** Ends a process by a signal's default action; see setDefaultSignalAction. */
  private defaultSignalAction: ((pid: number, code: number, signal: ProcessSignalName) => void) | null = null;
  /** Holds a process's output until its writes are published; see setOutputGate. */
  private outputGate: OutputGate | null = null;
  /** Each pid's latest output still held: what its next output goes after. */
  private readonly heldOutput = new Map<number, Promise<void>>();
  /** Pids a write of whose is in flight (retainAttribution), by count: not forgotten while held. */
  private readonly attributionLeases = new Map<number, number>();
  /** Processes of an earlier incarnation whose write logs are draining (adoptEnded): their exec ids. */
  private readonly adoptedExecIds = new Map<number, string | undefined>();
  /** The pids whose output is being delivered now: their own output made meanwhile goes with it. */
  private readonly releasing = new Set<number>();
  /**
   * The pids whose end is decided but not yet published: observers are told
   * they run. A pid's own slot, kept until its end is published, whatever
   * becomes of its table entry.
   */
  private readonly unpublishedEnds = new Set<number>();

  // ── Lifecycle / PID authority ─────────────────────────────────────────

  /**
   * Allocate a PID and register a new process. One with a parent and a
   * credential other than the parent's is made only if the identity policy
   * allows the change: refused, it is EPERM and no process.
   */
  spawn(command: string, argv: string[], cwd: string, opts: ProcessSpawnOptions = {}): ProcessEntry {
    if (this.refusal !== null) throw this.refusal;
    if (opts.parentPid !== undefined && opts.cred !== undefined && this.identityPolicy !== null) {
      const from = this.table.credOf(opts.parentPid);
      if (!sameIdentity(from, opts.cred) && !this.identityPolicy(from, opts.cred, command)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, uid ${from.uid} may not become uid ${opts.cred.uid} (${command})`), { code: 'EPERM', errno: -1 });
      }
    }
    const entry = this.table.spawn(command, argv, cwd, opts);
    if (opts.longRunning) this.table.setLongRunning(entry.pid);
    if (opts.attachedTty) this.table.setAttachedTty(entry.pid);
    return entry;
  }

  /**
   * Ask `policy` before each spawn as another identity (spawn). One policy
   * per supervisor: a second, other one is refused, so two workspaces over
   * one process table cannot disagree on it.
   */
  governIdentityChanges(policy: IdentityChangePolicy): void {
    if (this.identityPolicy !== null && this.identityPolicy !== policy) throw new Error('SessionProcessSupervisor: an identity policy is already installed');
    this.identityPolicy = policy;
  }

  /**
   * Admit no process from now on: each spawn throws `reason`. A destroy's,
   * before it takes the processes it stops, so none starts behind it.
   */
  closeAdmission(reason: Error): void {
    this.refusal = reason;
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

  /** `pid`'s lifecycle: ended as soon as its end is decided, which is what releases what it held. */
  get(pid: number): ProcessEntry | undefined {
    return this.table.get(pid);
  }

  /**
   * The exec `pid` is the work of (ProcessEntry.execId): what a write it
   * made is attributed to (VfsWriteEvent.execId). Undefined when its exec
   * named none, or no such process is known.
   */
  execIdOf(pid: number): string | undefined {
    const entry = this.table.get(pid);
    return entry === undefined ? this.adoptedExecIds.get(pid) : entry.execId;
  }

  /**
   * Keep `pid` in the table, answering execIdOf, until the returned release:
   * held for a write of its still in flight, or work that writes on its
   * behalf after it has ended. Its release (what it bound) is not held back:
   * only its forgetting.
   */
  retainAttribution(pid: number): () => void {
    this.attributionLeases.set(pid, (this.attributionLeases.get(pid) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const left = (this.attributionLeases.get(pid) ?? 1) - 1;
      if (left === 0) this.attributionLeases.delete(pid);
      else this.attributionLeases.set(pid, left);
    };
  }

  /**
   * `pid`, a process of an earlier incarnation whose write log is draining
   * now, was the work of `execId` (its journal's record of the table, taken
   * while it lived): execIdOf answers so until the returned release.
   */
  adoptEnded(pid: number, execId: string | undefined): () => void {
    this.adoptedExecIds.set(pid, execId);
    return () => { this.adoptedExecIds.delete(pid); };
  }

  /**
   * `pid`'s status as observers are told it (ps, process listings, a parent
   * waiting on it): its end once published, after the output before it
   * (releaseOutput); running until then.
   */
  published(pid: number): ProcessEntry | undefined {
    const entry = this.table.get(pid);
    return entry && this.asPublished(entry);
  }

  /** Every process, as observers are told it (see {@link published}). */
  publishedAll(): ProcessEntry[] {
    return this.table.getAll().map((entry) => this.asPublished(entry));
  }

  private asPublished(entry: ProcessEntry): ProcessEntry {
    return this.unpublishedEnds.has(entry.pid) ? { ...entry, state: 'running', exitCode: null, endTime: null } : entry;
  }

  /** Whether `pid`'s end is decided and still held from its observers (see {@link published}). */
  endHeld(pid: number): boolean {
    return this.unpublishedEnds.has(pid);
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

  /** `pid`'s running children, oldest first. */
  childrenOf(pid: number): number[] {
    return this.table.getRunning()
      .filter((entry) => entry.parentPid === pid)
      .sort((a, b) => a.startTime - b.startTime)
      .map((entry) => entry.pid);
  }

  // ── What a process waits on ───────────────────────────────────────────
  //
  // A process running in the session (a shell line) holds no worker and
  // reports nothing of itself; what it waits on is told here. Each unit of
  // its own in-flight work (a command executing) is counted (beginWork), and
  // so is each child it awaits (beginAwait, by whoever runs the child for
  // it). When every unit of its work is such an await, it is doing nothing
  // but wait on those children (awaitsOnly), and the Dynamic Worker ledger
  // can tell whether that wait can ever end.

  /** `pid` → its units of in-flight work. */
  private readonly works = new Map<number, number>();
  /** `pid` → the children it awaits, with how many awaits on each. */
  private readonly awaiting = new Map<number, Map<number, number>>();
  /** Fires when what a process waits on may have changed; see setOnWaitChange. */
  private onWaitChange: (() => void) | null = null;

  /** Told when what a process waits on may have changed (a work or an await ended, a process ended). */
  setOnWaitChange(cb: (() => void) | null): void {
    this.onWaitChange = cb;
  }

  /** `pid` has a unit of in-flight work of its own until the returned function is called. */
  beginWork(pid: number): () => void {
    this.works.set(pid, (this.works.get(pid) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.works.get(pid) ?? 1) - 1;
      if (left > 0) this.works.set(pid, left);
      else this.works.delete(pid);
      this.onWaitChange?.();
    };
  }

  /**
   * `pid` awaits its child `child`'s end, as one unit of its work, until
   * the returned function is called or either process ends. Told as a
   * change at once: the await may be what leaves `pid` doing nothing but
   * wait (a shell's `wait` on a job that is already running).
   */
  beginAwait(pid: number, child: number): () => void {
    let children = this.awaiting.get(pid);
    if (!children) this.awaiting.set(pid, children = new Map());
    children.set(child, (children.get(child) ?? 0) + 1);
    this.onWaitChange?.();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const now = this.awaiting.get(pid);
      const left = (now?.get(child) ?? 1) - 1;
      if (now && left > 0) now.set(child, left);
      else if (now) {
        now.delete(child);
        if (now.size === 0) this.awaiting.delete(pid);
      }
      this.onWaitChange?.();
    };
  }

  /**
   * This table as the Dynamic Worker ledger reads it (fabric
   * ProcessWaitGraph, bindProcessWaitGraph): a process's running children,
   * and what a process holding no worker awaits. Paired with
   * setOnWaitChange(processWaitGraphChanged). One binding for the session
   * and for the ledger's protocol model, so the model reads the accounting
   * the session keeps.
   */
  waitGraph(): { children(pid: number): number[]; awaits(pid: number): number[] | null } {
    return {
      children: (pid) => this.childrenOf(pid),
      awaits: (pid) => this.awaitsOnly(pid),
    };
  }

  /**
   * The children `pid` awaits, when awaiting them is every unit of its own
   * in-flight work; null when it has other work, or none.
   */
  awaitsOnly(pid: number): number[] | null {
    const works = this.works.get(pid) ?? 0;
    const children = this.awaiting.get(pid);
    if (works === 0 || !children) return null;
    let awaits = 0;
    for (const count of children.values()) awaits += count;
    return awaits === works ? [...children.keys()] : null;
  }

  /**
   * An ended process awaits nothing, and nothing awaits it any more; and it
   * is no longer among its parent's running children. Told as a change even
   * when it awaited nothing: the children are part of what the ledger reads.
   */
  private forgetWaits(pid: number): void {
    this.works.delete(pid);
    this.awaiting.delete(pid);
    for (const [parent, children] of this.awaiting) {
      if (children.delete(pid) && children.size === 0) this.awaiting.delete(parent);
    }
    this.onWaitChange?.();
  }

  /**
   * Register how to stop the work behind `pid`: a program run elsewhere (a
   * facet) whose run this session holds as a promise, so `kill` has to abort
   * it rather than only marking the table entry. What such a process bound
   * in the filesystem is its program's, and is released at its end. Cleared
   * once the process reaches a terminal state.
   */
  setTerminator(pid: number, terminate: () => void): void {
    this.terminators.set(pid, terminate);
  }

  /** Runtime composition adopts work already in flight, never cancelled work. */
  setWorkObservation(observe: (pid: number) => ProcessWorkObservation): void {
    this.observeWork = observe;
    for (const [pid, pieces] of this.held) for (const work of pieces) {
      work.observation?.release();
      work.observation = !work.stopped && !work.signal?.aborted ? observe(pid) : undefined;
    }
  }

  /**
   * This session runs work on `pid`'s own descriptors (a shell job, a
   * command run in the session): `stop` ends it, given the kill's reason
   * when it has one (SESSION_DESTROYED for a destroy's), and the function
   * returned says it has stopped, its own cleanup done. A kill stops it
   * rather than only marking the table entry.
   *
   * The work owns those descriptors while it runs and closes them itself, so
   * the process's release (setRelease) comes after: once its end is marked
   * and every piece of work held for it has stopped, whichever is last. A
   * process with nothing held for it (a program run elsewhere, or one whose
   * host was lost: nothing of it here is left to unwind) is released at its
   * end.
   */
  holdWork(pid: number, stop?: (reason?: SignalAbortReason) => void, signal?: AbortSignal): HeldProcessWork & { readonly signal: AbortSignal } {
    const owner = new AbortController();
    const ownSignal = owner.signal;
    // Each of the two ways the work is stopped ends what observes it: no listener of its own for that.
    const stopObserving = () => work.observation?.release();
    const abort = () => { owner.abort(signal?.reason); stopObserving(); };
    signal?.addEventListener('abort', abort, ONCE);
    if (signal?.aborted) owner.abort(signal.reason);
    const work = {
      stop: (reason?: SignalAbortReason) => { owner.abort(reason); stopObserving(); stop?.(reason); },
      stopped: false, signal: ownSignal,
      observation: ownSignal.aborted ? undefined : this.observeWork?.(pid),
    };
    let pieces = this.held.get(pid);
    if (!pieces) this.held.set(pid, pieces = new Set());
    pieces.add(work);
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', abort);
      stopObserving();
      const now = this.held.get(pid);
      now?.delete(work);
      if (now?.size === 0) this.held.delete(pid);
      this.releaseEnded(pid);
    };
    return Object.assign(release, { signal: ownSignal });
  }

  /** Whether `pid` runs, on work this session holds for it (holdWork, setTerminator): what a kill of it stops. */
  runsWork(pid: number): boolean {
    return this.table.get(pid)?.state === 'running' && (this.held.has(pid) || this.terminators.has(pid));
  }

  /** Stop the work behind `pid`: its terminator, and every piece held for it, once each, for `reason`. */
  private terminate(pid: number, reason?: SignalAbortReason): void {
    const terminator = this.terminators.get(pid);
    this.terminators.delete(pid);
    try { terminator?.(); } catch { /* the process is going away regardless */ }
    for (const work of this.held.get(pid) ?? []) {
      if (work.stopped) continue;
      work.stopped = true;
      work.observation?.release();
      try { work.stop(reason); } catch { /* the process is going away regardless */ }
    }
  }

  cred(pid: number): VfsCred {
    return this.table.credOf(pid);
  }

  /**
   * Whether `caller` may signal `pid`, by Linux's rule (kill(2)): root may
   * signal any process, any other caller only a process of its own uid. The
   * one rule every kill path a process or user takes asks.
   */
  maySignal(caller: Readonly<VfsCred>, pid: number): boolean {
    if (caller.uid === 0) return true;
    if (this.table.get(pid) === undefined) return false;
    return this.table.credOf(pid).uid === caller.uid;
  }

  /** {@link kill}, as `caller`: refused with EPERM where {@link maySignal} refuses it (isKillRefusal). */
  killAs(caller: Readonly<VfsCred>, pid: number, exitCode?: number, reason?: SignalAbortReason): boolean {
    if (!this.maySignal(caller, pid)) throw Object.assign(new Error(`EPERM: operation not permitted, kill ${pid}`), { code: 'EPERM', errno: -1 });
    return this.kill(pid, exitCode, reason);
  }

  /** `pid`'s controlling terminal (ProcessEntry.terminal), or undefined when it has none or is not in the table. */
  terminalOf(pid: number): string | undefined {
    return this.table.get(pid)?.terminal;
  }

  /** A shell made before its terminal takes it as its controlling terminal (ProcessTable.setTerminal). */
  setControllingTerminal(pid: number, terminal: string): void {
    this.table.setTerminal(pid, terminal);
  }

  /** The running processes whose controlling terminal is `terminal`: what closing it hangs up. */
  onTerminal(terminal: string): ProcessEntry[] {
    return this.table.onTerminal(terminal);
  }

  /** `pid` and the processes above it, nearest first, as the table has them now. */
  lineage(pid: number): number[] {
    const chain: number[] = [];
    for (let entry = this.table.get(pid); entry !== undefined && !chain.includes(entry.pid); entry = entry.parentPid === undefined ? undefined : this.table.get(entry.parentPid)) {
      chain.push(entry.pid);
    }
    return chain;
  }

  liveCred(pid: number): VfsCred {
    return this.table.liveCred(pid);
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

  /** Observe the authoritative end, even when that runtime has no log consumer. */
  subscribeTerminal(pid: number, listener: () => void): () => void {
    let subscribers = this.terminalSubscribers.get(pid);
    if (!subscribers) this.terminalSubscribers.set(pid, subscribers = new Set());
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
      if (subscribers.size === 0) this.terminalSubscribers.delete(pid);
    };
  }

  /**
   * `pid`'s exit status once it leaves `running`, however it leaves: what a
   * caller whose program ran on as a resident (FacetManager._promote) waits
   * on for that program's exit.
   */
  whenEnded(pid: number): Promise<number> {
    const entry = this.table.get(pid);
    if (entry?.state !== 'running') return Promise.resolve(entry?.exitCode ?? 0);
    return new Promise((resolve) => {
      this.subscribeTerminal(pid, () => resolve(this.table.get(pid)?.exitCode ?? 0));
    });
  }

  /** A decided end is told to observers (published) once the output before it is. */
  private publishEnd(pid: number, wasRunning: boolean): void {
    if (!wasRunning || this.table.get(pid)?.state === 'running') return;
    this.unpublishedEnds.add(pid);
    void this.releaseOutput(pid, () => { this.unpublishedEnds.delete(pid); });
  }

  private fireTerminal(pid: number, wasRunning: boolean): void {
    if (!wasRunning || this.table.get(pid)?.state === 'running') return;
    this.forgetWaits(pid);
    const subscribers = this.terminalSubscribers.get(pid);
    this.terminalSubscribers.delete(pid);
    for (const listener of subscribers ?? []) {
      try { listener(); } catch { /* the process is gone regardless */ }
    }
    if (!this.onTerminalCb) return;
    try { this.onTerminalCb(pid); } catch { /* the process is gone regardless */ }
  }

  /** Mark a process as exited. First terminal state wins. */
  exit(pid: number, exitCode: number): void {
    const wasRunning = this.table.get(pid)?.state === 'running';
    this.table.exit(pid, exitCode);
    if (wasRunning) this.ended?.(pid);
    this.releaseEnded(pid);
    this.publishEnd(pid, wasRunning);
    this.terminators.delete(pid);
    this.fireTerminal(pid, wasRunning);
  }

  /**
   * Mark a process as killed and tear down its input channel so queued
   * stdin can't outlive the process. `exitCode` is the ending signal's
   * status; SIGKILL's 137 when absent. `reason` is what its held work is
   * stopped with (holdWork).
   */
  kill(pid: number, exitCode?: number, reason?: SignalAbortReason): boolean {
    // A program that takes its own signals is sent the signal, and decides.
    const sent = reason === undefined ? null : parseProcessSignalName(`SIG${reason.signal}`);
    if (sent !== null && this.deliverSignal(pid, sent)) return true;
    const wasRunning = this.table.get(pid)?.state === 'running';
    const killed = this.table.kill(pid, exitCode);
    if (wasRunning) this.ended?.(pid);
    this.releaseEnded(pid);
    this.publishEnd(pid, wasRunning);
    this.terminate(pid, reason);
    this.input.close(pid);
    this.fireTerminal(pid, wasRunning);
    return killed;
  }

  /**
   * Clean up exited processes older than maxAge ms: each one's release (see
   * {@link setRelease}) is waited for, then its entry forgotten, as
   * {@link reapTree} does. A session prunes its table this way rather than
   * at each call's return. With no release set nothing is reaped. A reaped
   * pid whose logs hold no exit (a process killed around its log) is an
   * orphan from here, which gives its logs a deadline.
   *
   * A prune serves whoever runs next, not the processes it removes, so a
   * release that failed goes to that process's own stderr log, where its
   * output is read; every expired entry is still forgotten. One whose end is
   * still held from its observers has not ended to them, and waits for a
   * prune after it is published; one whose work is still stopping (holdWork)
   * waits for a prune after it has.
   */
  reap(maxAge?: number): Promise<number> {
    if (!this.release) return NOTHING_REAPED;
    const expired = this.table.expired(maxAge).filter((entry) => !this.unpublishedEnds.has(entry.pid) && !this.held.has(entry.pid) && !this.attributionLeases.has(entry.pid));
    // Each launch prunes: one with nothing to prune costs it a settled promise, not an async call.
    return expired.length === 0 ? NOTHING_REAPED : this.reapExpired(expired);
  }

  private async reapExpired(expired: ProcessEntry[]): Promise<number> {
    const { reaped, failures } = await this.forgetReleased(expired);
    for (const { pid, error } of failures) this.appendOutput(pid, 'stderr', `${error instanceof Error ? error.message : String(error)}\n`);
    return reaped;
  }

  /**
   * How an ended process lets go of what it bound in the filesystem (its
   * descriptor scope, its delegations, its watches): the `releaseProcess` of
   * the filesystem this table's processes bind to. One slot, set by the
   * workspace composed over this table, which owns that filesystem. It is
   * called once per process, at its end, however it ends (exit, kill, a lost
   * host: every end marks this table), so nothing it held outlives it to be
   * found by the next caller, a destroy among them. A prune reports how it
   * went (a descriptor's buffered bytes it lost) and forgets the entry.
   * `ended` is told at the end itself, before any held work has stopped:
   * what the process can no longer use (its read lease) goes then.
   */
  setRelease(release: (pid: number) => Promise<void>, ended?: (pid: number) => void): void {
    this.release = release;
    this.ended = ended ?? null;
  }

  /**
   * Remove `pid` and every process under it that has ended, now, as a parent
   * that waited for its children does: what a caller ran to completion has
   * nothing left to report. Each one's release is waited for (see
   * {@link setRelease}) before its entry goes; with no release set this
   * refuses. One still running, whose end is still held from its observers,
   * or whose work is still stopping, is kept. Logs are orphaned as by
   * {@link reap}.
   */
  async reapTree(pid: number): Promise<number> {
    if (!this.release) throw new Error('reapTree: this process table has no filesystem release; compose a workspace over it');
    const ended = [this.table.get(pid), ...this.table.descendantsOf(pid)]
      .filter((entry): entry is ProcessEntry => entry !== undefined && entry.state !== 'running'
        && !this.unpublishedEnds.has(entry.pid) && !this.held.has(entry.pid) && !this.attributionLeases.has(entry.pid));
    const { reaped, failures } = await this.forgetReleased(ended);
    // The caller waited for this tree: it hears every failure, once all of it is gone.
    if (failures.length === 1) throw failures[0].error;
    if (failures.length > 1) throw new AggregateError(failures.map((f) => f.error), `releasing ${failures.length} ended processes failed`);
    return reaped;
  }

  /**
   * `pid` has ended and no work held for it is still stopping: its release
   * begins now, in the turn that settled the last of them. One that ended
   * before a release was set is released when it is pruned.
   */
  private releaseEnded(pid: number): void {
    const entry = this.table.get(pid);
    if (entry === undefined || entry.state === 'running') return;
    if (!this.held.has(pid)) {
      void this.releaseOf(pid);
      return;
    }
    if (this.stopBounds.has(pid)) return;
    this.stopBounds.set(pid, setTimeout(() => {
      this.stopBounds.delete(pid);
      if (!this.held.has(pid)) return;
      this.terminate(pid);
      this.held.delete(pid);
      void this.releaseOf(pid);
    }, HELD_WORK_STOP_MS));
  }

  /**
   * Settles once `pid`'s release has run, however it went; at once when
   * nothing of it is still to be released (it has, or there is no release
   * to wait for). What a caller that ended a process waits for before it
   * relies on what the process held being gone (a destroy), bounded by
   * HELD_WORK_STOP_MS for work that ignores its stop.
   */
  released(pid: number): Promise<void> {
    const begun = this.releases.get(pid);
    if (begun !== undefined) return begun.then(() => {});
    const entry = this.table.get(pid);
    if (this.release === null || entry === undefined || entry.state === 'running' || !this.held.has(pid)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiting = this.releaseWaiters.get(pid);
      if (waiting) waiting.push(resolve);
      else this.releaseWaiters.set(pid, [resolve]);
    });
  }

  /**
   * The program behind `pid`, run elsewhere, says it has ended, ahead of
   * the table hearing of it (its exit is told once its output is let out):
   * what it bound is released now, so what its last closes flush goes with
   * that output, unless work the session runs on the pid still holds it.
   */
  programEnded(pid: number): void {
    if (this.table.get(pid) === undefined || this.held.has(pid)) return;
    void this.releaseOf(pid);
  }

  /** `pid`'s release, begun once: how it went, a failure included. */
  private releaseOf(pid: number): Promise<{ error: unknown } | null> {
    let released = this.releases.get(pid);
    if (released !== undefined) return released;
    const release = this.release;
    if (release === null) return Promise.resolve(null);
    try {
      released = release(pid).then(() => null, (error: unknown) => ({ error }));
    } catch (error) {
      released = Promise.resolve({ error });
    }
    this.releases.set(pid, released);
    const bound = this.stopBounds.get(pid);
    if (bound !== undefined) clearTimeout(bound);
    this.stopBounds.delete(pid);
    const waiting = this.releaseWaiters.get(pid);
    this.releaseWaiters.delete(pid);
    for (const resolve of waiting ?? []) void released.then(resolve);
    return released;
  }

  /**
   * Forget each entry once its release is done. A release that failed stops
   * nothing: releaseProcess revokes everything before it reports what it
   * could not do, so the entry is forgotten either way and the failure is
   * returned.
   */
  private async forgetReleased(
    entries: readonly ProcessEntry[],
  ): Promise<{ reaped: number; failures: { pid: number; error: unknown }[] }> {
    const failures: { pid: number; error: unknown }[] = [];
    // Each release began at its process's end: they are waited for together.
    const released = await Promise.all(entries.map((entry) => this.releaseOf(entry.pid)));
    let reaped = 0;
    entries.forEach((entry, i) => {
      const failed = released[i];
      if (failed !== null) failures.push({ pid: entry.pid, error: failed.error });
      // Leased while its release ran (retainAttribution): kept, released, for a later reap.
      if (this.attributionLeases.has(entry.pid)) return;
      this.releases.delete(entry.pid);
      this.table.forget(entry.pid);
      reaped++;
    });
    if (reaped > 0) this.logRetention?.();
    return { reaped, failures };
  }

  get stats(): ProcessTable['stats'] {
    return this.table.stats;
  }

  /** See ProcessTable.residentRunning — running long-running process count. */
  get residentRunning(): number {
    return this.table.residentRunning;
  }

  /** See ProcessTable.setPidBase — generation-unique pid allocation. */
  onPidStride(listener: (stride: number) => void): void {
    this.table.onPidStride(listener);
  }

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

  inheritInput(pid: number, parentPid: number): void { this.input.inherit(pid, parentPid); }
  pumpInput(pid: number, source: { readBytes(maxLength: number): Promise<Uint8Array | null> }): { stop(): void; done: Promise<void> } { return this.input.pump(pid, source); }

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

  /**
   * A pipe write to `pid`'s input, waiting for room. When `writer`, the
   * process writing, takes its own signals (takeSignals), a signal sent to
   * it while it waits answers instead, as a write is interrupted, and the
   * write is withdrawn, taking nothing. `gone` (its caller has left) ends a
   * wait the same way, with what it has not written unwritten.
   */
  async writeInputBytesWait(pid: number, data: Uint8Array, writer?: number, gone?: AbortSignal): Promise<{ ok: boolean; signal?: ProcessSignalName }> {
    const box = writer === undefined ? undefined : this.signalBoxes.get(writer);
    // One there is room for does not wait, and nothing interrupts it.
    if (writer === undefined || box === undefined || this.input.hasRoom(pid, data.byteLength)) return this.input.writeBytesWait(pid, data, gone);
    const withdraw = new AbortController();
    gone?.addEventListener('abort', () => withdraw.abort(), { once: true });
    if (gone?.aborted) withdraw.abort();
    const writing = this.input.writeBytesWait(pid, data, withdraw.signal);
    // Its waits for a signal end at their bound, or when its program lets go of its signals: the write is then waited for alone.
    while (this.signalBoxes.get(writer) === box) {
      const wait = this.waitSignal(box, SIGNAL_WAIT_MAX_MS);
      const first = await Promise.race([writing.then((result) => ({ result })), wait.signal.then((signal) => ({ signal }))]);
      if ('result' in first) {
        // A signal it took as the write was made is the next wait's.
        wait.cancel();
        const late = await wait.signal;
        if (late !== null) box.queued.unshift(late);
        return first.result;
      }
      if (first.signal === null) continue;
      withdraw.abort();
      const result = await writing;
      // Made before it could be withdrawn: the signal is the next wait's.
      if (result.ok) {
        box.queued.unshift(first.signal);
        return result;
      }
      return { ok: false, signal: first.signal };
    }
    return writing;
  }

  endInputAfterWrites(pid: number): Promise<void> { return this.input.endAfterWrites(pid); }

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

  /**
   * `pid`'s next input, waiting up to `waitMs` for it. For a program that
   * takes its own signals (takeSignals), a signal sent to it while it waits
   * answers instead, as a read is interrupted, and the read takes nothing.
   */
  async readInput(pid: number, waitMs?: number, maxBytes?: number): Promise<ProcessInputPacket> {
    const box = this.signalBoxes.get(pid);
    // Parked, its signals wait for the run that comes next: its input does not carry them.
    if (box === undefined || box.parked) return this.input.read(pid, waitMs, maxBytes);
    box.handed = null;
    const queued = box.queued.shift();
    if (queued !== undefined) {
      box.handed = { signal: queued };
      return { data: '', ended: false, signal: queued };
    }
    const withdraw = new AbortController();
    const reading = this.input.read(pid, waitMs, maxBytes, withdraw.signal);
    const wait = this.waitSignal(box, waitMs ?? 1000);
    const first = await Promise.race([reading.then((packet) => ({ packet })), wait.signal.then((signal) => ({ signal }))]);
    if ('packet' in first) {
      // A signal that came with it is the next wait's.
      wait.cancel();
      const late = await wait.signal;
      // Back to the queue, unless a park has given it back already.
      const given = wait.given();
      if (late !== null && given !== null && box.handed === given) {
        box.handed = null;
        box.queued.unshift(late);
      }
      return first.packet;
    }
    withdraw.abort();
    if (first.signal === null) return reading;
    // Input that came with it goes back for the next read.
    const packet = await reading;
    if (packet.ended || packet.data.length > 0 || packet.resize || packet.signal) this.input.unread(pid, [packet]);
    return { data: '', ended: false, signal: first.signal };
  }

  /**
   * Until `pid` ends or the returned release is called (its program's run
   * ended: the process may run another), its program takes the signals it
   * `catches`: one sent to it (a kill, the terminal's keys, a client's
   * frame) is queued for it to take (nextSignal), and what it does is the
   * program's, as a process's own handlers decide. Any other, SIGKILL among
   * them, still ends it. Its runner says so when its image takes what its
   * host delivers (GIT_RUNNER_CONTRACTS).
   */
  takeSignals(pid: number, catches: readonly ProcessSignalName[]): () => void {
    if (this.table.get(pid)?.state !== 'running' || this.signalBoxes.has(pid)) return () => {};
    const box: SignalBox = { catches: new Set(catches.filter((signal) => signal !== 'SIGKILL')), queued: [], taker: null, parked: false, handed: null };
    this.signalBoxes.set(pid, box);
    // What was sent and not taken goes with its program.
    const release = (): void => {
      if (this.signalBoxes.get(pid) !== box) return;
      this.signalBoxes.delete(pid);
      box.taker?.(null);
    };
    const unsubscribe = this.subscribeTerminal(pid, release);
    return () => {
      unsubscribe();
      release();
    };
  }

  /**
   * `pid`'s program says which signals it catches now, as a Node process's
   * listeners come and go: the offer takeSignals makes, made, or its
   * catches changed (none: each signal takes its default action again).
   * Until it ends, each it catches is queued for it (nextSignal).
   */
  catchSignals(pid: number, catches: readonly ProcessSignalName[]): void {
    const box = this.signalBoxes.get(pid);
    if (box === undefined) {
      if (catches.length > 0) this.takeSignals(pid, catches);
      return;
    }
    // A parked box stays parked: a run says what it catches as it starts, before a replay's boundary.
    box.catches = new Set(catches.filter((signal) => signal !== 'SIGKILL'));
  }

  /**
   * `pid`'s program's run, past a replay's boundary, takes back its parked
   * box (parkSignals): what waits there is its to take, by its waits or with
   * its input.
   */
  takeSignalsBack(pid: number): void {
    const box = this.signalBoxes.get(pid);
    if (box !== undefined) box.parked = false;
  }

  /**
   * `pid`'s program's run has stopped (a read it waits for, a listen), and
   * the next will take over: until then what it catches waits in its box,
   * not given to the stopped run's wait (answered none) nor to the next
   * run's preparation, and a signal the stopped run was given but did not
   * ask past goes back to the front.
   */
  parkSignals(pid: number, catches?: readonly ProcessSignalName[]): void {
    // What it catches by its stopped run's own word (its stop record's), which may not have reached here.
    if (catches !== undefined) {
      if (!this.signalBoxes.has(pid) && catches.length > 0) this.takeSignals(pid, catches);
      const made = this.signalBoxes.get(pid);
      if (made !== undefined) made.catches = new Set(catches.filter((signal) => signal !== 'SIGKILL'));
    }
    const box = this.signalBoxes.get(pid);
    if (box === undefined) return;
    box.parked = true;
    if (box.handed !== null) {
      box.queued.unshift(box.handed.signal);
      box.handed = null;
    }
    box.taker?.(null);
  }

  /** The first signal sent to `pid`'s program that waits in its box, never handed to it (takeSignals), or null. */
  untakenSignal(pid: number): ProcessSignalName | null {
    return this.signalBoxes.get(pid)?.queued[0] ?? null;
  }

  /** Whether `pid`'s program catches `signal` (takeSignals, catchSignals): one sent to it is its own to take. */
  catchesSignal(pid: number, signal: ProcessSignalName): boolean {
    return this.signalBoxes.get(pid)?.catches.has(signal) === true;
  }

  /**
   * The next signal sent to `pid`'s program (takeSignals), waiting up to
   * `waitMs` for one: null if none came, the process ended, or a later wait
   * took its place (one waits at a time). A program that takes none waits
   * as long, for none: a guest that asks again at once does not spin.
   */
  nextSignal(pid: number, waitMs: number): Promise<ProcessSignalName | null> {
    const box = this.signalBoxes.get(pid);
    if (box === undefined) return new Promise((resolve) => setTimeout(() => resolve(null), signalWaitMs(waitMs)));
    // It asks again: what it was given it has.
    box.handed = null;
    return this.waitSignal(box, waitMs).signal;
  }

  /** {@link nextSignal}'s wait on `box`, and its cancel, which answers it null if it is still the one waiting. */
  private waitSignal(box: SignalBox, waitMs: number): { signal: Promise<ProcessSignalName | null>; cancel(): void; given(): { readonly signal: ProcessSignalName } | null } {
    const queued = box.queued.shift();
    if (queued !== undefined) {
      const handed = { signal: queued };
      box.handed = handed;
      return { signal: Promise.resolve(queued), cancel: () => {}, given: () => handed };
    }
    box.taker?.(null);
    let take: (signal: ProcessSignalName | null) => void = () => {};
    let handed: { readonly signal: ProcessSignalName } | null = null;
    const signal = new Promise<ProcessSignalName | null>((resolve) => {
      const timer = setTimeout(() => take(null), signalWaitMs(waitMs));
      take = (sent) => {
        clearTimeout(timer);
        if (box.taker === take) box.taker = null;
        if (sent !== null) {
          handed = { signal: sent };
          box.handed = handed;
        }
        resolve(sent);
      };
      box.taker = take;
    });
    return { signal, cancel: () => { if (box.taker === take) take(null); }, given: () => handed };
  }

  /**
   * `signal` queued for `pid`'s program if it takes its own and catches it
   * (takeSignals): whether it does. A kill path that ends a process past
   * this table (its host's resources first) asks this before it does.
   */
  deliverSignal(pid: number, signal: ProcessSignalName): boolean {
    const box = this.signalBoxes.get(pid);
    if (!box || !box.catches.has(signal)) return false;
    if (box.taker && !box.parked) box.taker(signal);
    else box.queued.push(signal);
    return true;
  }

  /**
   * `reason`'s signal to `pid` and every process below it, as a terminal's
   * key signals its foreground job's process group: each takes it as
   * {@link kill} gives it, its program's own where it takes its signals, its
   * end where not.
   */
  signalGroup(pid: number, reason: SignalAbortReason): void {
    const group = this.getAll()
      .filter((entry) => entry.state === 'running' && this.lineage(entry.pid).includes(pid))
      .map((entry) => entry.pid);
    for (const member of group) this.kill(member, exitCodeForSignal(reason.signal), reason);
  }

  /**
   * `reason`'s signal to the foreground job of the shell `pid`, as a
   * terminal's key after the first (which the job's command took as its
   * abort): each running process below the shell whose output is the
   * terminal's (setForeground), the topmost of each such chain, with its
   * group ({@link signalGroup}). Nothing inside a background job (`cmd &`,
   * from any subshell) is the foreground's, nor is a server an earlier
   * command left running: it gave the terminal back.
   */
  signalForeground(pid: number, reason: SignalAbortReason): void {
    const ownsTerminal = (entry: ProcessEntry | undefined) => entry !== undefined && entry.state === 'running' && entry.foreground === true;
    const leaders = this.getAll().filter((entry) => {
      if (!ownsTerminal(entry) || entry.backgroundJob === true) return false;
      const above = this.lineage(entry.pid).slice(1);
      const shell = above.indexOf(pid);
      return shell >= 0 && above.slice(0, shell).every((ancestor) => {
        const between = this.table.get(ancestor);
        return between?.backgroundJob !== true && !ownsTerminal(between);
      });
    });
    for (const leader of leaders) this.signalGroup(leader.pid, reason);
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
    // A program that takes its own signals is sent it, whatever it would do by default.
    if (this.deliverSignal(pid, signal)) return { ok: true };
    // Whether its default action ends a process, and the status it ends with:
    // the shell's table (signals.ts), Linux's dispositions and numbers.
    const name = parseSignalName(signal);
    const terminates = name !== null && signalDisposition(name) === 'terminate';
    const entry = this.table.get(pid);
    // Only an attached program reads its signals from this channel; a job
    // that never reads it is not "not yet started". SIGKILL cannot be caught,
    // blocked or ignored: it ends any running process at once, whether or not
    // the process reads this channel — a launch stuck before its first read
    // (a top-level await that never settles) or a background job that never
    // opens one was otherwise unkillable.
    const uncatchable = signal === 'SIGKILL';
    if (terminates && entry?.state === 'running'
      && (uncatchable || (entry.attachedTty === true && this.input.has(pid) && !this.input.hasReader(pid)))) {
      const code = exitCodeForSignal(name);
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

  /**
   * Hold each process's output (its log and live sinks, a pipe to another
   * process, the terminal, its exit) until `gate` lets it through. One slot.
   */
  setOutputGate(gate: OutputGate | null): void {
    this.outputGate = gate;
  }

  /** `pid`'s output leaves, from now on, by a way no gate sees (a socket an answer of its hands over): its gate is told. */
  escapeOutput(pid: number): void {
    this.outputGate?.escaped?.(pid);
  }

  /**
   * `deliver` once `pid`'s output may reach its observers: now, when the
   * gate holds nothing of pid's, else after the gate and after pid's output
   * before it, in the order the process made it. Every observer of a
   * process's output and its exit is reached through here.
   */
  releaseOutput<T>(pid: number, deliver: () => T): T | Promise<Awaited<T>> {
    if ((this.outputGate === null && this.heldOutput.size === 0) || this.releasing.has(pid)) return deliver();
    const prior = this.heldOutput.get(pid);
    const gated = this.outputGate?.before(pid) ?? null;
    const turn = prior === undefined ? gated : gated === null ? prior : Promise.all([prior, gated]);
    if (turn === null) return this.deliverOutput(pid, deliver);
    let delivery!: T;
    const admitted = turn.then(() => { delivery = this.deliverOutput(pid, deliver); });
    // What comes after waits for this to be let through, not for its readers.
    const held = admitted.then(() => {}, () => {});
    this.heldOutput.set(pid, held);
    void held.then(() => { if (this.heldOutput.get(pid) === held) this.heldOutput.delete(pid); });
    return (async (): Promise<Awaited<T>> => {
      await admitted;
      return await delivery;
    })();
  }

  private deliverOutput<T>(pid: number, deliver: () => T): T {
    this.releasing.add(pid);
    try {
      return deliver();
    } finally {
      this.releasing.delete(pid);
    }
  }

  appendOutput(pid: number, stream: LogStream, data: string): void {
    void this.releaseOutput(pid, () => {
      this.logs.append(pid, stream, data);
      this.logActivity?.();
    });
  }

  /** Store bytes once, and await the live byte sink's pipe backpressure. */
  appendOutputBytes(pid: number, stream: LogStream, data: Uint8Array): Promise<void> {
    return this.releaseOutput(pid, () => {
      const delivery = this.logs.appendBytes(pid, stream, data);
      this.logActivity?.();
      return delivery;
    });
  }

  /** Record exit in the log store, after the output before it. Idempotent: the first record wins. */
  markExit(pid: number, code: number, reason?: string): void {
    void this.releaseOutput(pid, () => {
      this.logs.markExit(pid, code, reason);
      this.logActivity?.();
    });
  }

  getExit(pid: number): ProcessExitInfo | null {
    return this.logs.getExit(pid);
  }

  hasLogs(pid: number): boolean {
    return this.logs.has(pid);
  }

  retainsLogs(pid: number): boolean { return this.logs.retains(pid); }

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

  subscribeOutputBytes(pid: number, cb: (chunk: ByteLogChunk) => void | Promise<void>): () => void { return this.logs.subscribeBytes(pid, cb); }

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

/** Whether `error` is {@link SessionProcessSupervisor.killAs}'s refusal: kill(2)'s rule does not let the caller signal the process. */
export function isKillRefusal(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
}
