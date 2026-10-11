import type { ShellInputSubmission, ShellIntegrationEvent } from '../../../shell/input-submission.js';

export interface ITerminal {
  write(data: string): void;
  writeln(data: string): void;
  onData(callback: (data: string, submission?: ShellInputSubmission) => void | Promise<void>): void;
  onSubmission?(callback: (data: string, id: string, deliver: (submission: ShellInputSubmission) => void | Promise<void>, repl: boolean) => void | Promise<void>): void;
  shellIntegration?(event: ShellIntegrationEvent): void;
  readonly cols: number;
  readonly rows: number;
  focus(): void;
  clear(): void;
}
