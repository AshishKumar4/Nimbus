import type { ShellInputSubmission, ShellIntegrationEvent } from '../../../shell/input-submission.js';

export interface ITerminal {
  readonly signal?: AbortSignal;
  write(data: string): void;
  writeln(data: string): void;
  onData(callback: (data: string, submission?: ShellInputSubmission) => void | Promise<void>): void;
  onSubmission?(callback: (data: string, id: string, deliver: (submission: ShellInputSubmission) => void | Promise<void>, repl: boolean) => void | Promise<void>): void;
  shellIntegration?(event: ShellIntegrationEvent): void;
  readonly cols: number;
  readonly rows: number;
  /** How many writes it has taken: a shell compares it to tell whether anything was written after its own. */
  readonly writes?: number;
  /** Whether the last write ended a line (or nothing was written). */
  readonly endsLine?: boolean;
  focus(): void;
  clear(): void;
}
