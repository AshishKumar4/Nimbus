import type { Command } from '../commands/types.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { Kernel } from '../kernel/index.js';
import type { Shell } from '../shell/Shell.js';
import type { ITerminal } from '../terminal/ITerminal.js';

// ─── Sandbox Options ───

// ─── Command Execution ───

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

// ─── SandboxCommands ───

export interface SandboxCommands {
  run(cmd: string, options?: RunOptions): Promise<CommandResult>;
  register(name: string, handler: Command): void;
  /**
   * The command table itself, for layering a command set over the defaults.
   * Public because composing a workspace means replacing builtins wholesale —
   * the durable-filesystem coreutils override ~25 of them — and every caller
   * that needed it was already reaching through the private field.
   */
  readonly registry: CommandRegistry;
}

// ─── Internal types for Sandbox internals ───

export interface SandboxInternals {
  kernel: Kernel;
  shell: Shell;
}
