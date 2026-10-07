import type { Shell } from '../shell/Shell.js';
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
export declare function runCommand(shell: Shell, cmd: string, options?: RunOptions): Promise<CommandResult>;
//# sourceMappingURL=run-command.d.ts.map