import type { Shell } from '../shell/Shell.js';
import { textCapture } from '../utils/bytes-io.js';

export interface RunOptions {
  /** Working directory for this command */
  cwd?: string;
  /** Extra environment variables for this command */
  env?: Record<string, string>;
  /** Abort signal to cancel the command */
  signal?: AbortSignal;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Streaming stdout callback; bytes, see Shell's ExecuteOptions */
  onStdout?: (data: Uint8Array) => void;
  /** Streaming stderr callback; bytes */
  onStderr?: (data: Uint8Array) => void;
  /** Provide stdin content */
  stdin?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run one command line on `shell` and collect its result. Whatever shell it is
 * given is the one the command acts on; it queues nothing, so two calls on two
 * shells run at once.
 */
export async function runCommand(shell: Shell, cmd: string, options?: RunOptions): Promise<CommandResult> {
  if (options?.signal?.aborted) return { stdout: '', stderr: '', exitCode: 130 };
  // The caller's signal, and the timeout's when there is one: the shell's own controller follows it.
  const timeout = options?.timeout ? AbortSignal.timeout(options.timeout) : undefined;
  const signal = timeout && options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout ?? options?.signal;

  // The result carries the output even when the caller also streams it;
  // the shell captures only a stream nobody sinks, so a sunk one is teed.
  let stdout = '';
  let stderr = '';
  const onStdout = options?.onStdout;
  const onStderr = options?.onStderr;
  const stdoutTee = onStdout && tee(onStdout, (text) => { stdout += text; });
  const stderrTee = onStderr && tee(onStderr, (text) => { stderr += text; });
  let result: Awaited<ReturnType<Shell['execute']>>;
  try {
    result = await shell.execute(cmd, {
      cwd: options?.cwd,
      env: options?.env,
      onStdout: stdoutTee?.write,
      onStderr: stderrTee?.write,
      stdin: options?.stdin,
      signal,
    });
  } finally {
    // The captures end with the run: bytes a character left unfinished are in the result.
    stdoutTee?.end();
    stderrTee?.end();
  }
  return {
    exitCode: result.exitCode,
    stdout: onStdout ? stdout : result.stdout,
    stderr: onStderr ? stderr : result.stderr,
  };
}

/** `sink`'s bytes, and their text to `capture` as the shell captures text (textCapture), which `end` ends. */
function tee(sink: (data: Uint8Array) => void, capture: (text: string) => void): { write(data: Uint8Array): void; end(): void } {
  const text = textCapture(capture);
  return {
    write: (data) => {
      text.stream.writeBytes(data);
      sink(data);
    },
    end: () => text.end(),
  };
}
