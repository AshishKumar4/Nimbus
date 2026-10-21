/**
 * A program placed on a mount's machine (ProgramPlacement 'delegated'), run
 * over a command's streams: what the shell, execvp's callers and a node
 * child's host share.
 */
import type { CommandInputStream } from '../substrate/lifo/commands/types.js';
import { exitCodeForSignal, signalAbortReasonOf } from '../substrate/lifo/shell/signals.js';
import { isBrokenPipe } from '../substrate/lifo/utils/bytes-io.js';
import { STREAM_CHUNK_BYTES } from '../_shared/byte-stream.js';
import type { ExecDelegate, ExitStatus, StartedProgram } from './program-start.js';

/** A start the delegate refused: execve's failure, by its errno name (`ENOENT`, `EHOSTDOWN`). Nothing ran. */
export class ProgramRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ProgramRefusal';
  }
}

/** Where the program's streams go and come from. Each write's wait is the program's. */
export interface DelegatedStreams {
  /** fd 0, read as the program reads it; null when it has none. */
  readonly stdin: CommandInputStream | null;
  stdout(bytes: Uint8Array): Promise<void>;
  stderr(bytes: Uint8Array): Promise<void>;
}

/**
 * `argv` started by `delegate` from `cwd` (its mount's terms) with `env`,
 * and run to its end: its exit as waitpid reports it.
 * - A start the delegate refuses throws ProgramRefusal; nothing ran.
 * - `cancel` is the caller's stop: before the start, the delegate's own
 *   cancellation; after it, the signal its reason names (`SIGINT` for
 *   Ctrl-C), sent to the program, which ends as it decides.
 * - A write its reader refuses (a closed pipe) is SIGPIPE to the program,
 *   as a write to a pipe with no reader is, and its output is not read on.
 * - `onStarted` hears of the start, for a caller with its own signals to send.
 */
export async function runDelegatedProgram(
  delegate: ExecDelegate,
  program: { readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd: string },
  streams: DelegatedStreams,
  cancel: AbortSignal,
  onStarted?: (started: StartedProgram) => void,
): Promise<ExitStatus> {
  // Its input is read only as it reads, and not at all once it has ended:
  // a terminal's next keys are the shell's.
  const done = new AbortController();
  let started: StartedProgram;
  try {
    started = await delegate.start({ ...program, stdin: streams.stdin === null ? null : inputOf(streams.stdin, done.signal) }, cancel);
  } catch (error) {
    done.abort();
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'EIO';
    throw new ProgramRefusal(code, error instanceof Error ? error.message : String(error));
  }
  onStarted?.(started);
  const send = (): void => started.kill(`SIG${signalAbortReasonOf(cancel)?.signal ?? 'TERM'}`);
  if (cancel.aborted) send();
  else cancel.addEventListener('abort', send, { once: true });
  try {
    const output = started.output.getReader();
    for (;;) {
      const next = await output.read();
      if (next.done) break;
      try {
        await (next.value.stream === 'stderr' ? streams.stderr : streams.stdout)(next.value.data);
      } catch (error) {
        if (!isBrokenPipe(error)) throw error;
        started.kill('SIGPIPE');
        await output.cancel();
        break;
      }
    }
    return await started.exit;
  } finally {
    cancel.removeEventListener('abort', send);
    done.abort();
  }
}

/** `stdin` as a byte stream the program pulls: nothing is read ahead of it, and nothing once `stop` aborts. */
function inputOf(stdin: CommandInputStream, stop: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stop.aborted) return controller.close();
      const chunk = stdin.readBytes ? await stdin.readBytes(STREAM_CHUNK_BYTES, stop) : await stdin.read();
      if (chunk === null) return controller.close();
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    },
  }, { highWaterMark: 0 });
}

/** A program's end as the shell reports it: its exit code, or 128+n for the signal that ended it. */
export function shellStatusOf(exit: ExitStatus): number {
  return exit.signal === null ? exit.code : exitCodeForSignal(exit.signal.replace(/^SIG/, ''));
}
