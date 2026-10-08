export type ShellIntegrationEvent = {
    type: 'shell-integration';
    event: 'prompt';
} | {
    type: 'shell-integration';
    event: 'input';
    submissionId: string;
    ownerId: string;
} | {
    type: 'shell-integration';
    event: 'start';
    submissionId: string;
} | {
    type: 'shell-integration';
    event: 'finish' | 'end';
    submissionId: string;
    exitCode: number | null;
};
/** One client's input batch, including its queued lines and command status. */
export declare class ShellInputSubmission {
    readonly id: string;
    private readonly publish;
    private pending;
    private atPrompt;
    private status;
    private ended;
    constructor(id: string, publish: (event: ShellIntegrationEvent) => void);
    retain(): () => void;
    release(): void;
    leavePrompt(): void;
    start(): ShellInputExecution;
    finish(status: number | null): void;
    inherit(status: number | null): void;
    prompt(): void;
    private end;
}
/** A foreground execution finishes its stdin users before its batch's next line. */
export declare class ShellInputExecution {
    readonly owner?: ShellInputSubmission | undefined;
    private status;
    private readonly inputs;
    constructor(owner?: ShellInputSubmission | undefined);
    bind(submission: ShellInputSubmission): void;
    finish(status: number | null): void;
    prompt(): void;
}
export interface QueuedShellInput {
    readonly data: string;
    readonly submission: ShellInputSubmission;
    readonly release: () => void;
    readonly resolve?: () => void;
    readonly reject?: (error: Error) => void;
}
export type ShellQueuedInput = string | QueuedShellInput;
//# sourceMappingURL=input-submission.d.ts.map