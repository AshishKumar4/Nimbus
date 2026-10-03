import type { Shell } from '../shell/Shell.js';
import type { RunOptions, CommandResult } from './types.js';
import { textSink } from '../../../_shared/bytes.js';

/**
 * Run one command line on `shell` and collect its result. Whatever shell it is
 * given is the one the command acts on; it queues nothing, so two calls on two
 * shells run at once.
 */
export async function runCommand(shell: Shell, cmd: string, options?: RunOptions): Promise<CommandResult> {
  const signal = options?.signal;
  if (signal?.aborted) return { stdout: '', stderr: '', exitCode: 130 };
  const controller = options?.timeout ? new AbortController() : undefined;
  const forwardAbort = () => controller?.abort(signal?.reason);
  if (controller && signal) signal.addEventListener('abort', forwardAbort, { once: true });
  const timeoutId = controller ? setTimeout(() => controller.abort(), options?.timeout) : null;

  // The result carries the output even when the caller also streams it;
  // the shell captures only a stream nobody sinks, so a sunk one is teed.
  let stdout = '';
  let stderr = '';
  const onStdout = options?.onStdout;
  const onStderr = options?.onStderr;
  try {
    const result = await shell.execute(cmd, {
      cwd: options?.cwd,
      env: options?.env,
      onStdout: onStdout && tee(onStdout, (text) => { stdout += text; }),
      onStderr: onStderr && tee(onStderr, (text) => { stderr += text; }),
      stdin: options?.stdin,
      signal: controller?.signal ?? signal,
    });
    return {
      exitCode: result.exitCode,
      stdout: onStdout ? stdout : result.stdout,
      stderr: onStderr ? stderr : result.stderr,
    };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function tee(sink: (data: Uint8Array) => void, capture: (text: string) => void): (data: Uint8Array) => void {
  const decode = textSink(capture);
  return (data) => {
    decode(data);
    sink(data);
  };
}
