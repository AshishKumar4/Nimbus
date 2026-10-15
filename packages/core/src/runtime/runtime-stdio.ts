import type { CommandContext, CommandInputStream } from '../substrate/lifo/commands/types.js';
import type { NimbusFilesystemAuthority, VfsCred } from './os-contracts.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
import { stdinBytesOf } from '../shell/stdin-adapter.js';
import { outputHooks } from '../_shared/byte-stream.js';
import { signalAbortReasonOf } from '../substrate/lifo/shell/signals.js';
import { NIMBUS_SIGNAL_ERRNOS } from './wasi/types.js';
import { parseProcessSignalName, type ProcessSignalName } from './process-io-protocol.js';

/** The signals a WASI image that takes its own is sent (NIMBUS_SIGNAL_ERRNOS). */
const DELIVERED_SIGNALS: readonly ProcessSignalName[] = Object.keys(NIMBUS_SIGNAL_ERRNOS)
  .map(parseProcessSignalName)
  .filter((signal): signal is ProcessSignalName => signal !== null);

/** What one run of a runtime is: its process, and what its fd0/1/2 read and write. */
export interface InvocationStdioSpec {
  /** Its process, when one was made for it (a broker's); absent, the run makes its own, a child of `parentPid`. */
  readonly existingPid: number | undefined;
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly parentPid: number | undefined;
  readonly cred: VfsCred;
  /**
   * The caller's: its abort ends the run, as a kill of its process does; or,
   * for a program that takes its own signals (`takesSignals`), sends it and
   * the processes below it the abort's signal, as a terminal's key does its
   * foreground job's process group, and the run goes on until it ends.
   */
  readonly signal: AbortSignal | undefined;
  /** Its program takes its own signals (SessionProcessSupervisor.takeSignals): its image delivers what it is sent (NIMBUS_ESIGNAL). */
  readonly takesSignals?: boolean;
  /** What fd 0 reads, pumped in; null when it reads nothing of the caller's (a broker's input, or stdin already read). */
  readonly input: Pick<CommandInputStream, 'read' | 'readBytes'> | null;
  /** Where fd 1 and 2 go; null when a broker routes them. */
  readonly output: ((stream: 'stdout' | 'stderr', bytes: Uint8Array) => void | Promise<void>) | null;
}

/**
 * A run's fd0/1/2, on the process supervisor's byte channels: its process
 * (made, or the broker's), the signal that ends it, its input pumped (fd 0
 * at EOF when nothing is) and its output delivered. `release` stops them as
 * the run ends; ending an owned process is the runner's, once it has said
 * what it has to.
 */
export function openInvocationStdio(processes: SessionProcessSupervisor, spec: InvocationStdioSpec) {
  const owned = spec.existingPid === undefined;
  const entry = spec.existingPid === undefined
    ? processes.spawn(spec.command, [...spec.argv], spec.cwd, { parentPid: spec.parentPid, cred: spec.cred })
    : processes.get(spec.existingPid);
  if (!entry || entry.state !== 'running') throw new Error(`${spec.command}: runtime process is not running`);
  const pid = entry.pid;
  const controller = new AbortController();
  // Its program's for this run alone: an adopted process runs on after it.
  const releaseSignals = spec.takesSignals ? processes.takeSignals(pid, DELIVERED_SIGNALS) : null;
  const abort = (): void => {
    const sent = spec.takesSignals && spec.signal ? signalAbortReasonOf(spec.signal) : null;
    if (sent !== null && sent.signal !== 'KILL') processes.signalGroup(pid, sent);
    else controller.abort(spec.signal?.reason);
  };
  if (spec.signal?.aborted) abort();
  else spec.signal?.addEventListener('abort', abort, { once: true });
  processes.setTerminator(pid, () => controller.abort());
  const input = spec.input ? processes.pumpInput(pid, stdinBytesOf(spec.input)) : null;
  if (!processes.hasInput(pid)) {
    processes.openInput(pid);
    processes.endInput(pid);
  }
  const output = spec.output;
  const unsubscribe = output ? processes.subscribeOutputBytes(pid, ({ stream, data }) => output(stream, data)) : null;
  if (unsubscribe) processes.setForeground(pid, true);
  return {
    pid,
    owned,
    cred: entry.cred,
    signal: controller.signal,
    release() {
      spec.signal?.removeEventListener('abort', abort);
      releaseSignals?.();
      input?.stop();
      if (owned) processes.closeInput(pid);
      unsubscribe?.();
      if (unsubscribe) processes.setForeground(pid, false);
    },
  };
}

/** A runtime's fd0/1/2 for a command's run (openInvocationStdio over its CommandContext). */
export function openRuntimeStdio(
  deps: { filesystem: NimbusFilesystemAuthority; processes: SessionProcessSupervisor },
  ctx: CommandContext,
  command: string,
  { consumedStdin = false, takesSignals = false } = {},
) {
  const reserved = (ctx as CommandContext & {
    __nimbusBinSpawn?: { callerPid?: number; liveInput?: boolean };
  }).__nimbusBinSpawn;
  // A broker already owns this input and routes its output to the parent's
  // pipes. Pumping or subscribing a second time would duplicate that path.
  const brokerIo = reserved?.liveInput === true;
  const output = brokerIo ? null : runtimeOutput(ctx);
  if (takesSignals) ctx.takesSignals?.();
  const stdio = openInvocationStdio(deps.processes, {
    existingPid: reserved?.callerPid,
    command,
    argv: [command],
    cwd: ctx.cwd || '/home/user',
    parentPid: ctx.pid,
    cred: ctx.cred,
    signal: ctx.signal,
    takesSignals,
    input: !brokerIo && !consumedStdin && ctx.stdin ? ctx.stdin : null,
    output: output === null ? null : (stream, bytes) => output.write(stream, bytes),
  });
  return {
    pid: stdio.pid,
    signal: stdio.signal,
    syscalls: { pid: stdio.pid, vfs: deps.filesystem.bind({ pid: stdio.pid, cred: stdio.cred }), processes: deps.processes },
    async finish(exitCode: number) {
      stdio.release();
      // Its last bytes before its exit: a character they left unfinished is written.
      try { await output?.end(); } finally {
        if (stdio.owned) deps.processes.exit(stdio.pid, exitCode);
      }
    },
  };
}

/** A runtime's byte callback into the command's outputs, and `end`, which ends their decoding once the runtime is done. */
export function runtimeOutput(ctx: Pick<CommandContext, 'stdout' | 'stderr'>): {
  write(stream: 'stdout' | 'stderr', bytes: Uint8Array): Promise<void>;
  end(): Promise<void>;
} {
  const hooks = outputHooks(ctx);
  return {
    write: (stream, bytes) => (stream === 'stdout' ? hooks.onStdout(bytes) : hooks.onStderr(bytes)),
    end: () => hooks.end(),
  };
}
