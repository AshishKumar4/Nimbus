import type { CommandContext } from '../substrate/lifo/commands/types.js';
import type { NimbusFilesystemAuthority } from './os-contracts.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
import { stdinBytesOf } from '../shell/stdin-adapter.js';
import { outputHooks } from '../_shared/byte-stream.js';

/** A runtime's fd0/1/2, on the process supervisor's existing byte channels. */
export function openRuntimeStdio(
  deps: { filesystem: NimbusFilesystemAuthority; processes: SessionProcessSupervisor },
  ctx: CommandContext,
  command: string,
  { consumedStdin = false } = {},
) {
  const reserved = (ctx as CommandContext & {
    __nimbusBinSpawn?: { callerPid?: number; liveInput?: boolean };
  }).__nimbusBinSpawn;
  const owned = reserved?.callerPid === undefined;
  const entry = owned
    ? deps.processes.spawn(command, [command], ctx.cwd || '/home/user', { parentPid: ctx.pid, cred: ctx.cred })
    : deps.processes.get(reserved!.callerPid!);
  if (!entry || entry.state !== 'running') throw new Error(`${command}: runtime process is not running`);
  const pid = entry.pid;
  const controller = new AbortController();
  const abort = () => controller.abort(ctx.signal?.reason);
  if (ctx.signal?.aborted) abort();
  else ctx.signal?.addEventListener('abort', abort, { once: true });
  deps.processes.setTerminator(pid, () => controller.abort());

  // A broker already owns this input and routes its output to the parent's
  // pipes. Pumping or subscribing a second time would duplicate that path.
  const brokerIo = reserved?.liveInput === true;
  const input = !brokerIo && !consumedStdin && ctx.stdin
    ? deps.processes.pumpInput(pid, stdinBytesOf(ctx.stdin)) : null;
  if (!deps.processes.hasInput(pid)) {
    deps.processes.openInput(pid);
    deps.processes.endInput(pid);
  }
  const output = runtimeOutput(ctx);
  const unsubscribe = brokerIo ? null : deps.processes.subscribeOutputBytes(pid, ({ stream, data }) => output.write(stream, data));
  if (unsubscribe) deps.processes.setForeground(pid, true);
  return {
    pid,
    signal: controller.signal,
    syscalls: { pid, vfs: deps.filesystem.bind({ pid, cred: entry.cred }), processes: deps.processes },
    async finish(exitCode: number) {
      ctx.signal?.removeEventListener('abort', abort);
      input?.stop();
      unsubscribe?.();
      if (unsubscribe) deps.processes.setForeground(pid, false);
      // Its last bytes before its exit: a character they left unfinished is written.
      try { await output.end(); } finally {
        if (owned) { deps.processes.closeInput(pid); deps.processes.exit(pid, exitCode); }
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
