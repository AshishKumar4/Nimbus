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
  private resolveCompletion: (status: number | null) => void = () => {};
  readonly completion: Promise<number | null>;

  constructor(readonly id: string, private readonly publish: (event: ShellIntegrationEvent) => void) {
    this.completion = new Promise((resolve) => { this.resolveCompletion = resolve; });
  }

  retain(): () => void {
    this.pending++;
    return () => this.release();
  }

  release(): void {
    this.pending--;
    if (this.pending === 0 && this.atPrompt) this.end(this.status);
  }

  bind(owner: ShellInputSubmission): void {
    if (owner === this) return;
    void owner.completion.then((status) => this.end(status));
  }

  start(): void {
    this.atPrompt = false;
    this.publish({ type: 'shell-integration', event: 'start', submissionId: this.id });
  }

  finish(status: number | null): void {
    this.status = status;
    this.publish({ type: 'shell-integration', event: 'finish', submissionId: this.id, exitCode: status });
  }

  prompt(): void {
    this.atPrompt = true;
    if (this.pending === 0) this.end(this.status);
  }

  private end(status: number | null): void {
    if (this.ended) return;
    this.ended = true;
    this.publish({ type: 'shell-integration', event: 'end', submissionId: this.id, exitCode: status });
    this.resolveCompletion(status);
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
