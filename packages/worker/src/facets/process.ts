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
 * stdin uses the shared process input channel; stdout/stderr use bounded
 * per-child pipes. cpReadOutput long-polls for incremental delivery
 * to the parent; cpDrainOutput is a one-shot full-flush invoked from the
 * parent's exit path so unawaited children don't lose output. A child's
 * stdin is a pipe: what runs it here reads the queue as a stream, as the
 * parent writes it (`_stdinOf`), and a runtime's facet reads the same channel
 * through cpReadStdin.
 *
 * Children run concurrently, as Node's do: each is dispatched on its own,
 * and nothing here waits for one child before starting the next. What a
 * child spends of the session's shared budgets it spends where it is spent
 * (a facet program's Dynamic Worker is admitted by the fabric's ledger).
 *
 * Lifecycle invariants:
 *   - exitCode is stamped exactly once (first writer wins). kill() and
 *     reportExit() race-free.
 *   - kill() runs the session's kill of the pid (its launch's terminator,
 *     and the release of what it held) before it stamps the exit, which
 *     wakes every pending waiter, so cpWait/cpReadOutput don't hang and
 *     nothing the child held outlives it.
 */

import { singleQuote } from '@nimbus-sh/core/_shared/shell-quote.js';
import { resolveVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { parseShellInvocation, type ShellName } from '@nimbus-sh/core/shell/shell-invocation.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { ProcessView } from '@nimbus-sh/core/runtime/process-files.js';
import { enc, dec } from '@nimbus-sh/core/_shared/bytes.js';
import { exitCodeForSignal, parseSignalName, signalDisposition } from '@nimbus-sh/core/substrate/lifo/shell/signals.js';
import { isDynamicWorkerDeadlock } from '@nimbus-sh/fabric/budgets.js';
import { pulledStdinReader, staticStdinReader } from '@nimbus-sh/core/shell/stdin-adapter.js';
import type { CommandInputStream } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import { forgetFacetStorage } from '@nimbus-sh/core/runtime/storage-ledger.js';
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';

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
 * read incrementally with cpReadOutput(sinceSeq). The data is bytes: a
 * child's stdio is not text, and a string here would lose any byte sequence
 * that is not valid UTF-8.
 */
interface OutputChunk {
  seq: number;
  data: Uint8Array;
  /** Its number among the parent's news (FacetProcessManagerDeps.issueNews); 0 for none. */
  news: number;
}

/**
 * Per-child mutable state. Created on spawn, torn down only when the
 * parent reaps via cpReap or after a configurable idle timeout (we leave
 * the entry around for late drain/wait calls).
 */
interface ChildEntry {
  pid: number;
  /** The process that spawned it: whom its output, start and exit are news for. */
  parentPid: number;
  /** The descriptors its parent reads: output to an ignored one reaches nobody. */
  stdio: Array<'pipe' | 'ignore' | 'inherit'>;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  startedAt: number;
  endedAt: number | null;

  // stdout/stderr ring (child → parent)
  // fd 1 = stdout, fd 2 = stderr.
  outputs: {
    1: OutputChunk[];
    2: OutputChunk[];
  };
  outputSeq: { 1: number; 2: number };
  outputBytes: { 1: number; 2: number };
  outputDrained: Array<() => void>;
  outputWrites: { 1: Promise<void>; 2: Promise<void> };
  parentClosed: (() => void) | null;
  outputWaiters: Array<{ fd: 1 | 2; sinceSeq: number; resolve: (r: ReadOutputResult) => void; expiresAt: number }>;

  // Exit slot (first-writer-wins). A child a signal ended keeps the
  // shell's status (128+signo) here, for the process table; its parent is
  // told what Node tells, the signal with no status (ChildExitStatus).
  exitCode: number | null;
  signal: string | null;
  killed: boolean;
  /** The errno code of a spawn that failed: the child never ran (EAGAIN: no room to start it). */
  spawnError: string | null;
  /**
   * The child has started: its runner admitted it (a facet program, once
   * its launch is let in on the Dynamic Worker ledger) or began it (a
   * builtin, a shell line). Until then it is pending, and may yet be
   * refused (spawnError). A parent's ChildProcess emits 'spawn' on this.
   */
  started: boolean;
  /** Woken when the child starts, or ends, whichever is first. */
  startWaiters: Array<() => void>;
  exitWaiters: Array<(r: ChildExitStatus) => void>;

  // The parent's news of it, numbered as it is produced (issueNews): its
  // start, its exit, and the end of each output stream the parent reads.
  // Each reply that delivers one carries its number. 0: none issued.
  startNews: number;
  exitNews: number;
  closedNews: { 1: number; 2: number };
}

/**
 * How a child ended, as Node's ChildProcess reports it: an exit status and
 * no signal, or the signal that ended it and no status. A spawn that failed
 * has `spawnError` (its errno code) and the negative errno as its status.
 */
export interface ChildExitStatus {
  done: boolean;
  exitCode: number | null;
  signal: string | null;
  spawnError?: string;
  /** Not done, but started: what a wait that asked to hear of the start answers. */
  started?: boolean;
  /** The parent's news this answer delivers (FacetProcessManagerDeps.issueNews). */
  news?: number[];
}

export interface SpawnReq {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdio: ('pipe' | 'ignore' | 'inherit')[];
  detached?: boolean;
  shell?: boolean | string;
  stdin?: string;
  /** Supervisor-assigned invoking process PID. */
  parentPid: number;
}

export interface ReadOutputResult {
  chunks: { seq: number; data: Uint8Array }[];
  closed: boolean;
  maxSeq: number;
  /** The parent's news this answer delivers (FacetProcessManagerDeps.issueNews). */
  news?: number[];
}

export interface DrainResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  stdoutClosed: boolean;
  stderrClosed: boolean;
}

/**
 * Hooks invoked by a child's runner (builtin, shell line or facet program)
 * to push output into the per-child ring. Kept as a small structural type
 * so tests can supply mocks. They carry bytes; a text producer encodes at
 * its own edge (see `textBytes`).
 */
export interface OutputHooks {
  onStdout: (data: Uint8Array) => void | Promise<void>;
  onStderr: (data: Uint8Array) => void | Promise<void>;
  /** The runner has started the program: a facet program's launch was let in (ChildEntry.started). */
  onStarted?: () => void;
}

/** A text producer's edge onto the byte hooks. */
export function textBytes(text: string): Uint8Array {
  return enc.encode(text);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { joined.set(c, at); at += c.byteLength; }
  return joined;
}

/**
 * Command resolution. The shell registry returns whatever shape it likes;
 * we adapt to a normalized 3-state result.
 */
export type CommandKind = 'pure-builtin' | 'facet-direct' | 'shell-direct' | 'unknown';

/**
 * The minimum shape we need from the FacetManager. Production passes
 * the real FacetManager; tests pass a mock with execStream.
 */
export interface FacetManagerLike {
  /** `opts.stdin` is the command's stdin, a pipe it reads as it arrives. */
  execStream(
    code: string,
    opts: { facetName?: string; cwd?: string; env?: Record<string, string>; argv?: string[]; stdin?: CommandInputStream },
    hooks: OutputHooks,
  ): Promise<number>;
  /**
   * The session's kill of `pid` by `signal` (a name without SIG): the work
   * behind it ends (its launch's terminator), and what it held is released
   * and its exit reported (ports, RPC resources, relayed sockets). False when
   * it is not running.
   */
  kill(pid: number, signal: string): boolean;
}

/** Where a child runs from: its pid (whose credential it has), directory and environment. */
export interface ChildOrigin {
  readonly pid: number;
  readonly cwd: string;
  readonly env: Record<string, string>;
}

/**
 * The minimum shape we need from the command registry.
 */
export interface CommandRegistryLike {
  /** How `name` runs as the child `from` describes; null while nothing can run it. */
  resolve(name: string, from: ChildOrigin): Promise<{ kind: CommandKind } | null>;
  runPureBuiltin(
    pid: number,
    name: string,
    args: string[],
    env: Record<string, string>,
    cwd: string,
    stdin: CommandInputStream,
    hooks: OutputHooks,
  ): Promise<number>;
}

export interface ShellExecutorLike {
  execute(
    pid: number,
    commandLine: string,
    env: Record<string, string>,
    cwd: string,
    stdin: CommandInputStream,
    hooks: OutputHooks,
  ): Promise<number>;
}

/**
 * Constructor deps bundle. Keeping it as a single object simplifies
 * tests AND makes the production wiring in nimbus-session.ts read
 * declaratively.
 */
export interface FacetProcessManagerDeps {
  facetMgr: FacetManagerLike;
  processes: SessionProcessSupervisor;
  /** The process's own view of the namespace: where `sh <script>` reads the script, as the process. */
  vfsForProcess: (pid: number) => Pick<ProcessView, 'exists' | 'readFileString' | 'isDirectory'>;
  commandRegistry: CommandRegistryLike;
  shellExecutor?: ShellExecutorLike;
  /**
   * Number a piece of news of a child as it is produced, for its parent
   * `parentPid`: output the parent reads, the child's start, the end of a
   * stream, its exit (fabric issueProcessNews). The reply that delivers it
   * carries the number, and the parent's report that it is blocked counts
   * only once it has applied every number issued. 0: not numbered.
   */
  issueNews?: (parentPid: number) => number;
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

type ShellSpawnPlan =
  | { kind: 'command'; commandLine: string; args: string[] }
  | { kind: 'script'; path: string; args: string[] }
  | { kind: 'stdin'; args: string[] };

/** A spawn's stdio as the parent's ChildProcess reads it (node-shims _normalizeStdio): a mode per descriptor. */
function normalizeStdio(stdio: unknown): Array<'pipe' | 'ignore' | 'inherit'> {
  const mode = (v: unknown) => (v === 'ignore' || v === 'inherit' ? v : 'pipe');
  if (typeof stdio === 'string') return [mode(stdio), mode(stdio), mode(stdio)];
  if (!Array.isArray(stdio)) return ['pipe', 'pipe', 'pipe'];
  return [mode(stdio[0]), mode(stdio[1]), mode(stdio[2])];
}

function basenameOfCommand(command: string): string {
  const text = String(command || '').trim();
  if (!text) return '';
  const slash = text.lastIndexOf('/');
  return slash >= 0 ? text.slice(slash + 1) : text;
}

function isShellCommand(command: string): boolean {
  const base = basenameOfCommand(command);
  return base === 'sh' || base === 'bash';
}

function normalizeVirtualCommand(command: string): string {
  const text = String(command || '').trim();
  if (!text.startsWith('/')) return text;
  const base = basenameOfCommand(text);
  const dir = text.slice(0, Math.max(0, text.length - base.length));
  if (dir === '/bin/' || dir === '/usr/bin/' || dir === '/usr/local/bin/') {
    return base;
  }
  return text;
}

function shellNameForCommand(command: string): ShellName {
  return basenameOfCommand(command) === 'bash' ? 'bash' : 'sh';
}

function parseShellCommandArgs(command: string, args: string[]): ShellSpawnPlan | null {
  const parsed = parseShellInvocation(shellNameForCommand(command), args);
  if (!parsed.ok) return null;
  if (parsed.invocation.kind === 'command') {
    return { kind: 'command', commandLine: parsed.invocation.body, args: parsed.invocation.args };
  }
  if (parsed.invocation.kind === 'script') {
    return { kind: 'script', path: parsed.invocation.path, args: parsed.invocation.args };
  }
  // `bash --help` prints and exits; there is no process to spawn for it.
  if (parsed.invocation.kind === 'usage') return null;
  return { kind: 'stdin', args: parsed.invocation.args };
}

/** A spawn's word on its command line: bare when every character is plainly safe, else single-quoted. */
function quoteShellToken(value: string): string {
  return /^[A-Za-z0-9_\-./:=]+$/.test(value) ? value : singleQuote(value);
}

function shellLineFromSpawn(command: string, args: string[]): string {
  return [command, ...(Array.isArray(args) ? args : [])].map((part) => quoteShellToken(String(part))).join(' ');
}

export class FacetProcessManager {
  private children = new Map<number, ChildEntry>();
  private deps: FacetProcessManagerDeps;

  constructor(deps: FacetProcessManagerDeps) {
    this.deps = deps;
  }

  // ── spawn ───────────────────────────────────────────────────────────────

  /**
   * Allocate a child PID, classify the command, dispatch it to its runner.
   * Returns immediately with the child PID; the actual command executes
   * asynchronously, beside any other child, and pushes output via the
   * per-child hooks.
   */
  async spawn(req: SpawnReq): Promise<{ childPid: number }> {
    // Recursion-depth cap (env-propagated).
    const depthIn = parseInt(req.env?.NIMBUS_CP_DEPTH || '0', 10) || 0;
    if (depthIn >= CHILD_PROCESS_MAX_DEPTH) {
      // A spawn at a process limit: the parent's ChildProcess reports it as
      // Node does (code and errno ride across RPC).
      throw Object.assign(new Error(
        `EAGAIN: child_process spawn depth ${depthIn} exceeds ` +
        `CHILD_PROCESS_MAX_DEPTH=${CHILD_PROCESS_MAX_DEPTH}`,
      ), { code: 'EAGAIN', errno: -11 });
    }
    const childEnv: Record<string, string> = {
      ...req.env,
      NIMBUS_CP_DEPTH: String(depthIn + 1),
    };

    if (!Number.isInteger(req.parentPid) || req.parentPid <= 0) {
      throw new Error('child_process spawn requires a supervisor-assigned parent pid');
    }
    const commandLine = `${req.command} ${req.args.join(' ')}`.trim();
    const processEntry = this.deps.processes.spawn(
      commandLine,
      req.args,
      req.cwd,
      { parentPid: req.parentPid },
    );
    const pid = processEntry.pid;
    const child: ChildEntry = {
      pid,
      parentPid: req.parentPid,
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
    child.parentClosed = this.deps.processes.subscribeExit(req.parentPid, () => {
      if (child.exitCode === null) this.kill(pid, 'SIGTERM');
    });
    // Every child kind owns an fd onto the same input store. Runners in
    // this isolate consume it through _stdinOf; facets through cpReadStdin.
    if (child.stdio[0] === 'inherit') this.deps.processes.inheritInput(pid, req.parentPid);
    else this.deps.processes.openInput(pid);
    if (child.stdio[0] === 'ignore') this.deps.processes.endInput(pid);

    const shellPlan = this._shellPlanFor(req);
    const normalizedCommand = shellPlan ? 'sh' : normalizeVirtualCommand(req.command);
    const dispatchReq = shellPlan
      ? req
      : { ...req, command: normalizedCommand };
    let reg: { kind: CommandKind } | null;
    try {
      reg = shellPlan ? { kind: 'shell-direct' } : await this.deps.commandRegistry.resolve(normalizedCommand, { pid, cwd: req.cwd, env: childEnv });
      if (!reg || reg.kind === 'unknown') throw Object.assign(new Error(`spawn ${req.command} ENOENT`), { code: 'ENOENT', errno: -2, path: req.command });
    } catch (error) {
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
    setTimeout(() => {
      void (async () => {
        await this._dispatch(child, reg.kind, dispatchReq);
      })().catch((e) => {
        // Last resort: a classification or both runners threw (a registered
        // command's module that fails to load). Exit 1 with the error on stderr.
        this._appendText(child, 2, `Error: ${e?.message || String(e)}\n`);
        this._stampExit(child, 1, null);
      });
    }, 0);

    return { childPid: pid };
  }

  /**
   * Run the child to its end and stamp its exit. A facet program or a shell
   * line reads live stdin (NIMBUS_CP_CHILD_PID, cpReadStdin), as a Node
   * child_process pipe does; a pure builtin reads that same live byte channel.
   * Output goes straight to the child's bounded pipes while it runs,
   * so a prompt reaches the parent before the child waits for an answer.
   *
   * Runs in this isolate, on its own: a child that never exits holds nothing
   * a later child needs. (It used to be relayed through a single-slot Worker
   * Loader pool whose call stayed open for the child's life, so every later
   * spawn queued behind it, a kill included.)
   */
  private async _dispatch(child: ChildEntry, kind: CommandKind, req: SpawnReq): Promise<void> {
    if (child.exitCode !== null) return;
    if (kind === 'unknown') {
      this._markStarted(child);
      this._appendText(child, 2, `${req.command}: command not found\n`);
      this._stampExit(child, 127, null);
      return;
    }
    const hooks: OutputHooks = {
      onStdout: (d) => this._appendOutput(child, 1, d),
      onStderr: (d) => this._appendOutput(child, 2, d),
      onStarted: () => this._markStarted(child),
    };
    const cwd = String(req.cwd || '/home/user');
    // A builtin or a shell line starts as it is dispatched; a facet program
    // once its launch is let in (hooks.onStarted).
    if (kind !== 'facet-direct') this._markStarted(child);
    if (kind === 'pure-builtin') {
      const stdin = this._stdinOf(child);
      try {
        const code = await this.deps.commandRegistry.runPureBuiltin(
          child.pid, req.command, req.args, { ...child.env }, cwd, stdin, hooks,
        );
        this._stampExit(child, typeof code === 'number' ? code : 0, null);
      } catch (e: any) {
        this._appendText(child, 2, `Error: ${e?.message || String(e)}\n`);
        this._stampExit(child, 1, null);
      }
      return;
    }
    const env = { ...child.env, NIMBUS_CP_CHILD_PID: String(child.pid) };
    if (kind === 'shell-direct') {
      try {
        const plan = this._shellPlanFor(req);
        if (!plan) {
          this._appendText(child, 2, `${req.command}: unsupported shell invocation\n`);
          this._stampExit(child, 127, null);
          return;
        }
        const commandLine = await this._shellCommandLineForPlan(
          plan, cwd, this._stdinOf(child), hooks, shellNameForCommand(req.command), child.pid,
        );
        if (commandLine === null) {
          this._stampExit(child, 127, null);
          return;
        }
        const code = await this._runShellLine(child.pid, commandLine, env, cwd, this._stdinOf(child), hooks);
        this._stampExit(child, typeof code === 'number' ? code : 0, null);
      } catch (e: any) {
        this._appendText(child, 2, `shell error: ${e?.message || String(e)}\n`);
        this._stampExit(child, 1, null);
      }
      return;
    }
    // facet-direct: the program runs as this child's pid, in its own facet.
    const payload = JSON.stringify({
      command: req.command,
      args: req.args,
      env,
      cwd,
      stdin: '',
      processPid: child.pid,
    });
    try {
      const code = await this.deps.facetMgr.execStream(payload, { cwd, env, argv: req.args, stdin: this._stdinOf(child) }, hooks);
      this._stampExit(child, typeof code === 'number' ? code : 0, null);
    } catch (e: any) {
      // An initial admission refused before onStarted is a failed spawn.
      // A child already started (including one stopped on stdin whose
      // replay was refused) exists: stderr, exit 1 and close, never a second
      // spawn outcome or a negative errno in place of its exit.
      if (isDynamicWorkerDeadlock(e) && !child.started) {
        child.spawnError = e.code;
        this._stampExit(child, e.errno, null);
        return;
      }
      this._appendText(child, 2, `facet error: ${isDynamicWorkerDeadlock(e) ? `${e.code}: ` : ''}${e?.message || String(e)}\n`);
      this._stampExit(child, 1, null);
    }
  }

  /**
   * The child's stdin as a stream over its queue: each read takes what the
   * parent has written, waiting for it, and ends when the parent ends stdin
   * or the child exits. Nothing is read ahead of the command's own reads.
   */
  private _stdinOf(child: ChildEntry): CommandInputStream {
    return pulledStdinReader(async () => {
      for (;;) {
        const packet = await this.cpReadStdin(child.pid, 5000);
        if (packet.data.byteLength > 0) return packet.data;
        if (packet.ended) return null;
      }
    });
  }

  private _shellPlanFor(req: SpawnReq): ShellSpawnPlan | null {
    const args = Array.isArray(req.args) ? req.args.map(String) : [];
    if (req.shell) {
      if (isShellCommand(req.command)) return parseShellCommandArgs(req.command, args);
      return { kind: 'command', commandLine: shellLineFromSpawn(String(req.command), args), args: [] };
    }
    if (!isShellCommand(req.command)) return null;
    return parseShellCommandArgs(req.command, args);
  }

  private async _dispatchShell(child: ChildEntry, req: SpawnReq, hooks: OutputHooks): Promise<void> {
    const plan = this._shellPlanFor(req);
    if (!plan) {
      this._appendText(child, 2, `${req.command}: unsupported shell invocation\n`);
      this._stampExit(child, 127, null);
      return;
    }
    try {
      const stdin = this._stdinOf(child);
      const commandLine = await this._shellCommandLineForPlan(
        plan,
        req.cwd,
        stdin,
        hooks,
        shellNameForCommand(req.command),
        child.pid,
      );
      if (commandLine === null) {
        this._stampExit(child, 127, null);
        return;
      }
      const code = await this._runShellLine(child.pid, commandLine, child.env, req.cwd, stdin, hooks);
      this._stampExit(child, typeof code === 'number' ? code : 0, null);
    } catch (e: any) {
      this._appendText(child, 2, `shell error: ${e?.message || String(e)}\n`);
      this._stampExit(child, 1, null);
    }
  }

  /** The shell's program: its `-c` text, its script, or (`sh` alone) its stdin, which it then has none left of. */
  private async _shellCommandLineForPlan(
    plan: ShellSpawnPlan,
    cwd: string,
    stdin: CommandInputStream,
    hooks: OutputHooks,
    shellName: ShellName,
    processPid: number,
  ): Promise<string | null> {
    if (plan.kind === 'command') return plan.commandLine;
    if (plan.kind === 'stdin') return stdin.readAll();

    const scriptPath = '/' + resolveVfsPath(plan.path, cwd || '/home/user');
    try {
      const vfs = this.deps.vfsForProcess(processPid);
      if (!await vfs.exists(scriptPath) || await vfs.isDirectory(scriptPath)) {
        hooks.onStderr(textBytes(`${shellName}: ${plan.path}: No such file or directory\n`));
        return null;
      }
      return await vfs.readFileString(scriptPath);
    } catch (e: any) {
      hooks.onStderr(textBytes(`${shellName}: ${plan.path}: ${e?.message || String(e)}\n`));
      return null;
    }
  }

  private async _runShellLine(
    pid: number,
    commandLine: string,
    env: Record<string, string>,
    cwd: string,
    stdin: CommandInputStream,
    hooks: OutputHooks,
  ): Promise<number> {
    if (!this.deps.shellExecutor) {
      hooks.onStderr(textBytes('sh: shell executor unavailable\n'));
      return 127;
    }
    return this.deps.shellExecutor.execute(pid, commandLine, env, cwd || '/home/user', stdin, hooks);
  }

  // ── stdin queue ─────────────────────────────────────────────────────────

  async stdinWrite(childPid: number, data: Uint8Array): Promise<{ ok: boolean }> {
    const child = this.children.get(childPid);
    if (!child || child.exitCode !== null) return { ok: false };
    return this.deps.processes.writeInputBytesWait(childPid, data);
  }

  async stdinEnd(childPid: number): Promise<void> {
    const child = this.children.get(childPid);
    if (!child) return;
    await this.deps.processes.endInputAfterWrites(childPid);
  }

  /**
   * Put stdin the child took back in front of its queue, as it was, past the
   * queue's cap and after its end too: a run of the child that stopped
   * before using it, run again (runtime/stop-replay.ts).
   */
  unreadStdin(childPid: number, chunks: readonly Uint8Array[]): void {
    const child = this.children.get(childPid);
    if (!child || chunks.length === 0) return;
    this.deps.processes.unreadInput(childPid, chunks.map(data => ({ data, ended: false })));
  }

  /**
   * Long-poll: child facet asks the supervisor for its next stdin chunk.
   * Returns immediately if data is already queued OR if stdin is closed.
   */
  async cpReadStdin(childPid: number, waitMs: number, maxBytes?: number): Promise<{ data: Uint8Array; ended: boolean }> {
    const packet = await this.deps.processes.readInput(childPid, waitMs, maxBytes);
    return { ...packet, data: typeof packet.data === 'string' ? textBytes(packet.data) : packet.data };
  }

  // ── output queue ────────────────────────────────────────────────────────

  /** A broker-side text message onto the child's byte ring. */
  private _appendText(child: ChildEntry, fd: 1 | 2, text: string): void {
    this._appendOutput(child, fd, textBytes(text));
  }

  /** Whether this pid's descriptors belong to a child managed by this broker. */
  isChild(pid: number): boolean { return this.children.has(pid); }

  /** Whether this pid is a child of this broker that has not ended. */
  isRunning(pid: number): boolean { return this.children.get(pid)?.exitCode === null; }

  /** Runtime stdout/stderr for a broker-owned pid goes to its parent, not the shell. */
  routeOutput(pid: number, fd: 1 | 2, bytes: Uint8Array): Promise<void> | null {
    const child = this.children.get(pid);
    if (!child) return null;
    return child.exitCode === null ? this._appendOutput(child, fd, bytes) : Promise.resolve();
  }

  /** Internal: push a chunk to fd 1 or 2, fire log-store + waiters. */
  private _appendOutput(child: ChildEntry, fd: 1 | 2, data: Uint8Array): Promise<void> {
    const task = child.outputWrites[fd].then(async () => {
      if (child.stdio[fd] === 'ignore') return;
      for (let at = 0; at < data.byteLength; at += CHILD_STDIO_QUEUE_MAX_BYTES) {
        const piece = data.subarray(at, Math.min(data.byteLength, at + CHILD_STDIO_QUEUE_MAX_BYTES));
        while (child.outputBytes[fd] + piece.byteLength > CHILD_STDIO_QUEUE_MAX_BYTES) {
          if (child.exitCode !== null) throw Object.assign(new Error('EPIPE: child output reader is gone'), { code: 'EPIPE' });
          await new Promise<void>(resolve => child.outputDrained.push(resolve));
        }
        if (child.exitCode !== null) throw Object.assign(new Error('EPIPE: child output reader is gone'), { code: 'EPIPE' });
        this._pushOutput(child, fd, piece);
      }
    });
    child.outputWrites[fd] = task.catch(() => {});
    return task;
  }

  private _pushOutput(child: ChildEntry, fd: 1 | 2, data: Uint8Array): void {
    if (data.byteLength === 0) return;
    child.outputSeq[fd]++;
    const news = child.stdio[fd] !== 'ignore' ? this._news(child) : 0;
    const chunk: OutputChunk = { seq: child.outputSeq[fd], data, news };
    child.outputs[fd].push(chunk);
    child.outputBytes[fd] += data.byteLength;
    // Tee to the process supervisor's log ring for `logs <pid>` parity
    // with facet processes; the ring decodes at its own edge.
    try {
      this.deps.processes.appendOutputBytes(child.pid, fd === 1 ? 'stdout' : 'stderr', data);
    } catch { /* ignore */ }
    // Resolve waiters whose fd matches and whose sinceSeq is now satisfied.
    for (let i = child.outputWaiters.length - 1; i >= 0; i--) {
      const w = child.outputWaiters[i];
      if (w.fd !== fd) continue;
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
  private _readResult(child: ChildEntry, fd: 1 | 2, sinceSeq: number): ReadOutputResult {
    const fresh = child.outputs[fd].filter((c) => c.seq > sinceSeq);
    const closed = child.exitCode !== null;
    const news = fresh.map((c) => c.news);
    if (fresh.length > 0) news.push(child.startNews);
    if (closed) news.push(child.closedNews[fd]);
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
    // The next cursor acknowledges exactly what its reader consumed.
    const acknowledged = child.outputs[fd].filter(c => c.seq <= sinceSeq);
    if (acknowledged.length > 0) {
      child.outputs[fd] = child.outputs[fd].filter(c => c.seq > sinceSeq);
      for (const chunk of acknowledged) child.outputBytes[fd] -= chunk.data.byteLength;
      for (const wake of child.outputDrained.splice(0)) wake();
    }
    if (child.exitCode !== null || child.outputs[fd].some((c) => c.seq > sinceSeq)) {
      return this._readResult(child, fd, sinceSeq);
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
        resolve(this._readResult(child, fd, sinceSeq));
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
      return { stdout: EMPTY_BYTES, stderr: EMPTY_BYTES, stdoutClosed: true, stderrClosed: true };
    }
    // Wait briefly (up to 50ms) for the dispatch to settle if the child
    // hasn't exited yet — without this, drain races against the spawn's
    // queueMicrotask in the test interpreter / real facet startup.
    const t0 = Date.now();
    while (child.exitCode === null && Date.now() - t0 < 100) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return {
      stdout: concatBytes(child.outputs[1].map((c) => c.data)),
      stderr: concatBytes(child.outputs[2].map((c) => c.data)),
      stdoutClosed: child.exitCode !== null,
      stderrClosed: child.exitCode !== null,
    };
  }

  // ── kill / wait / reportExit ────────────────────────────────────────────

  /**
   * Synchronous kill. First-writer-wins on exit slot. The work behind the
   * pid ends first, through the session's own kill (FacetManagerLike.kill):
   * the terminator its launch registered aborts a facet program's run, so
   * the Dynamic Worker it held goes back to the ledger now rather than when
   * the program would have ended on its own, and its ports, RPC resources
   * and relayed sockets go with it. (`exit()`, which the stamp below calls,
   * drops that terminator without running it.) Then the stamp wakes every
   * waiter.
   */
  kill(childPid: number, signal: string | number = 'SIGTERM'): boolean {
    const child = this.children.get(childPid);
    if (!child || child.exitCode !== null) return false;
    // A name with or without SIG, or a number. One whose default action
    // does not end a process (SIGCHLD, SIGSTOP), the probe 0, or a name no
    // signal has ends nothing here.
    const name = parseSignalName(String(signal));
    if (name === null || name === '0' || signalDisposition(name) !== 'terminate') return false;

    child.killed = true;
    this.deps.facetMgr.kill(child.pid, name);
    this._stampExit(child, exitCodeForSignal(name), `SIG${name}`); // 128+signo, as the shell reports it
    return true;
  }

  /**
   * Stamp the exit slot. Idempotent — first call wins.
   * Wakes all waiters (exit, output, stdin) so callers don't hang.
   */
  private _stampExit(child: ChildEntry, exitCode: number, signal: string | null, flushed = false): void {
    if (child.exitCode !== null) return; // first writer wins
    // A command may issue writes without awaiting them. Its normal exit
    // waits for those bounded pipes; a kill cuts them off and wakes them.
    if (!flushed && signal === null) {
      void Promise.all([child.outputWrites[1], child.outputWrites[2]]).then(() => this._stampExit(child, exitCode, signal, true));
      return;
    }
    child.exitCode = exitCode;
    child.signal = signal;
    child.endedAt = Date.now();
    // Numbered before the process table hears of the exit, so the parent's
    // report is stale before its child is gone from the table. A refused
    // spawn's streams carry nothing: its parent ends them itself.
    child.exitNews = this._news(child);
    if (child.spawnError === null) {
      for (const fd of [1, 2] as const) if (child.stdio[fd] !== 'ignore') child.closedNews[fd] = this._news(child);
    }

    // Tell the process supervisor so `ps` and `logs <pid>` line up.
    try { this.deps.processes.exit(child.pid, exitCode); } catch {}
    try { this.deps.processes.markExit(child.pid, exitCode); } catch {}

    // Wake exit waiters.
    const status = this._exitStatus(child);
    for (const w of child.exitWaiters.splice(0)) w(status);
    // Wake output waiters with closed=true so polling parents stop.
    for (const w of child.outputWaiters.splice(0)) w.resolve(this._readResult(child, w.fd, w.sinceSeq));
    for (const wake of child.outputDrained.splice(0)) wake();
    this.deps.processes.closeInput(child.pid);
    child.parentClosed?.(); child.parentClosed = null;
  }

  /** A stamped child's end, as Node reports it (ChildExitStatus), with the news it delivers. */
  private _exitStatus(child: ChildEntry): ChildExitStatus {
    const numbers = [child.startNews, child.exitNews].filter((n) => n > 0);
    const news = numbers.length > 0 ? { news: numbers } : {};
    if (child.spawnError !== null) return { done: true, exitCode: child.exitCode, signal: null, spawnError: child.spawnError, ...news };
    return { done: true, exitCode: child.signal === null ? child.exitCode : null, signal: child.signal, ...news };
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
  async wait(childPid: number, waitMs: number = WAIT_MAX_MS, knownStarted = true): Promise<ChildExitStatus> {
    const child = this.children.get(childPid);
    if (!child) {
      return { done: true, exitCode: 1, signal: null };
    }
    if (child.exitCode !== null) return this._exitStatus(child);
    // A caller that has not heard of the start (a parent's ChildProcess,
    // which emits 'spawn' on it) is told of it as soon as it comes.
    const startNews = (): ChildExitStatus => ({
      done: false, exitCode: null, signal: null, started: true, ...(child.startNews > 0 ? { news: [child.startNews] } : {}),
    });
    if (!knownStarted && child.started) return startNews();
    return new Promise((resolve) => {
      const settle = (r: ChildExitStatus) => {
        clearTimeout(timer);
        const at = child.exitWaiters.indexOf(onExit);
        if (at >= 0) child.exitWaiters.splice(at, 1);
        const started = child.startWaiters.indexOf(onStart);
        if (started >= 0) child.startWaiters.splice(started, 1);
        resolve(r);
      };
      const timer = setTimeout(() => settle({ done: false, exitCode: null, signal: null }), Math.min(waitMs, WAIT_MAX_MS));
      const onExit = (r: ChildExitStatus) => settle(r);
      const onStart = () => { if (child.exitCode === null) settle(startNews()); };
      child.exitWaiters.push(onExit);
      if (!knownStarted) child.startWaiters.push(onStart);
    });
  }

  /** The child has started (ChildEntry.started): wake whoever waits to hear of it. */
  private _markStarted(child: ChildEntry): void {
    if (child.started) return;
    child.started = true;
    child.startNews = this._news(child);
    for (const w of child.startWaiters.splice(0)) w();
  }

  /** A piece of news of `child` for its parent, numbered (FacetProcessManagerDeps.issueNews). */
  private _news(child: ChildEntry): number {
    try { return this.deps.issueNews?.(child.parentPid) ?? 0; } catch { return 0; }
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
