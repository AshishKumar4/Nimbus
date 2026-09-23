import type { Shell } from '../shell/Shell.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { Command } from '../commands/types.js';
import type { SandboxCommands as ISandboxCommands, RunOptions, CommandResult } from './types.js';
import { textSink } from '../../../_shared/bytes.js';

/**
 * Wraps Shell.execute() and serializes concurrent calls.
 * Concurrent commands.run() calls are queued (matches real shell behavior).
 */
export class SandboxCommandsImpl implements ISandboxCommands {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private shell: Shell,
    readonly registry: CommandRegistry,
  ) {}

  run(cmd: string, options?: RunOptions): Promise<CommandResult> {
    // Serialize execution: queue each call so they run one at a time
    const result = new Promise<CommandResult>((resolve, reject) => {
      this.queue = this.queue.then(async () => {
        try {
          const res = await this.executeWithOptions(cmd, options);
          resolve(res);
        } catch (e) {
          reject(e);
        }
      });
    });
    return result;
  }

  register(name: string, handler: Command): void {
    this.registry.register(name, handler);
  }

  private async executeWithOptions(cmd: string, options?: RunOptions): Promise<CommandResult> {
    const signal = options?.signal;
    if (signal?.aborted) return { stdout: '', stderr: '', exitCode: 130 };
    const controller = options?.timeout ? new AbortController() : undefined;
    const forwardAbort = () => controller?.abort(signal?.reason);
    if (controller && signal) signal.addEventListener('abort', forwardAbort, { once: true });
    const timeoutId = controller ? setTimeout(() => controller.abort(), options?.timeout) : undefined;

    // The result carries the output even when the caller also streams it;
    // the shell captures only a stream nobody sinks, so a sunk one is teed.
    let stdout = '';
    let stderr = '';
    const onStdout = options?.onStdout;
    const onStderr = options?.onStderr;
    try {
      const result = await this.shell.execute(cmd, {
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
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      signal?.removeEventListener('abort', forwardAbort);
    }
  }
}

function tee(sink: (data: Uint8Array) => void, capture: (text: string) => void): (data: Uint8Array) => void {
  const decode = textSink(capture);
  return (data) => {
    decode(data);
    sink(data);
  };
}
