import type { ProcessView } from '../../../runtime/process-files.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';

export interface CommandOutputStream {
  write(text: string): void | Promise<void>;
  /**
   * Present on sinks that store bytes verbatim — files, `/dev/null`, and
   * byte-capable shell pipes. Sinks without it take decoded text instead.
   */
  writeBytes?(bytes: Uint8Array): void | Promise<void>;
  /**
   * Write anything the sink is holding. The shell flushes every descriptor
   * once the command that owns it finishes, and a failure is that command's.
   */
  flush?(): void | Promise<void>;
}

export interface CommandInputStream {
  read(): Promise<string | null>;   // null = EOF
  readAll(): Promise<string>;
  readLine?(): Promise<string | null>;
  /**
   * Bounded raw-byte read. Byte-capable sources (shell pipes, dumps) return
   * the original bytes; text-only sources encode what they hold. Null means
   * EOF with nothing returned.
   */
  readBytes?(maxLength: number): Promise<Uint8Array | null>;
  /**
   * The regular file a `< file` redirect opened, and how far into it this
   * stream has read: a command may read the file itself from there (at a
   * position, as a descriptor to a regular file allows) instead of reading
   * this stream.
   */
  readonly file?: { readonly path: string; readonly offset: number };
}
export interface TerminalInputStream extends CommandInputStream {
  rawMode: boolean;
}

/**
 * What a child process `runAs` starts inherits besides its credential: its
 * descriptors, environment and directory come from `parent`, which is the
 * calling command's own context unless given. A script interpreter passes the
 * context its script's command runs in (that line's redirections and pipes);
 * find -execdir passes its own with the matched file's directory.
 */
export interface RunAsOptions {
  readonly parent?: CommandContext;
}

/**
 * How a child process `runAs` started ended, as wait(2) reports it: `status`
 * is what `$?` shows for it (128 plus the signal's number when a signal
 * ended it), `signal` the name of that signal (`PIPE`), or null when the
 * child exited.
 */
export interface ChildExit {
  readonly status: number;
  readonly signal: string | null;
}

export interface CommandContext {
  pid: number;
  cred: VfsCred;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  vfs: ProcessView;
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
  signal: AbortSignal;
  stdin?: CommandInputStream;
  terminalStdin?: TerminalInputStream;
  setRawMode?: (enabled: boolean) => void;
  getRawMode?: () => boolean;
  isFdTerminal?: (fd: number) => boolean;
  /** Whether `fd` is a shell pipe (S_ISFIFO): its reader ends a writer by closing it. */
  isFdPipe?: (fd: number) => boolean;
  /** Whether the shell running this command runs `name` itself, as a builtin (type and command -v ask). */
  isShellBuiltin?: (name: string) => boolean;
  setUmask(mask: number): void;
  /** Run `argv` as a child process under `cred`, with this command's stdio and environment, and wait for it. */
  runAs(cred: VfsCred, argv: string[], options?: RunAsOptions): Promise<ChildExit>;
  execInterpreterDepth?: number;
}

export type CommandRunAsHost = (
  parent: CommandContext,
  cred: VfsCred,
  argv: string[],
) => Promise<ChildExit>;

export type Command = (ctx: CommandContext) => Promise<number>;
