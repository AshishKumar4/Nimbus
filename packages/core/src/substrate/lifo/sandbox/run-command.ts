import type { Shell } from '../shell/Shell.js';
import { textSink } from '../../../_shared/bytes.js';

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
  const result = await shell.execute(cmd, {
    cwd: options?.cwd,
    env: options?.env,
    onStdout: onStdout && tee(onStdout, (text) => { stdout += text; }),
    onStderr: onStderr && tee(onStderr, (text) => { stderr += text; }),
    stdin: options?.stdin,
    signal,
  });
  return {
    exitCode: result.exitCode,
    stdout: onStdout ? stdout : result.stdout,
    stderr: onStderr ? stderr : result.stderr,
  };
}

function tee(sink: (data: Uint8Array) => void, capture: (text: string) => void): (data: Uint8Array) => void {
  const decode = textSink(capture);
  return (data) => {
    decode(data);
    sink(data);
  };
}
