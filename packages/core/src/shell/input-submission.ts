export type ShellIntegrationEvent =
  | { type: 'shell-integration'; event: 'prompt' }
  | { type: 'shell-integration'; event: 'input'; submissionId: string; ownerId: string }
  | { type: 'shell-integration'; event: 'start'; submissionId: string }
  | { type: 'shell-integration'; event: 'finish' | 'end'; submissionId: string; exitCode: number | null };

/** One client's input batch, including its queued lines and command status. */
export class ShellInputSubmission {
  private pending = 1;
  private atPrompt = false;
  private status: number | null = null;
  private ended = false;
  constructor(readonly id: string, private readonly publish: (event: ShellIntegrationEvent) => void) {}

  retain(): () => void {
    this.pending++;
    return () => this.release();
  }

  release(): void {
    this.pending--;
    if (this.pending === 0 && this.atPrompt) this.end(this.status);
  }

  leavePrompt(): void { this.atPrompt = false; }

  start(): ShellInputExecution {
    this.leavePrompt();
    this.publish({ type: 'shell-integration', event: 'start', submissionId: this.id });
    return new ShellInputExecution(this);
  }

  finish(status: number | null): void {
    this.status = status;
    this.publish({ type: 'shell-integration', event: 'finish', submissionId: this.id, exitCode: status });
  }

  inherit(status: number | null): void { this.status = status; }

  prompt(): void {
    this.atPrompt = true;
    if (this.pending === 0) this.end(this.status);
  }

  private end(status: number | null): void {
    if (this.ended) return;
    this.ended = true;
    this.publish({ type: 'shell-integration', event: 'end', submissionId: this.id, exitCode: status });
  }
}

/** A foreground execution finishes its stdin users before its batch's next line. */
export class ShellInputExecution {
  private status: number | null = null;
  private readonly inputs: Array<{ submission: ShellInputSubmission; release: () => void }> = [];

  constructor(readonly owner?: ShellInputSubmission) {}

  bind(submission: ShellInputSubmission): void {
    if (submission !== this.owner) this.inputs.push({ submission, release: submission.retain() });
  }

  finish(status: number | null): void {
    this.status = status;
    this.owner?.finish(status);
  }

  prompt(): void {
    for (const { submission, release } of this.inputs) {
      submission.inherit(this.status);
      submission.prompt();
      release();
    }
  }
}

export interface QueuedShellInput {
  readonly data: string;
  readonly submission: ShellInputSubmission;
  readonly release: () => void;
  readonly resolve?: () => void;
  readonly reject?: (error: Error) => void;
}

export type ShellQueuedInput = string | QueuedShellInput;
