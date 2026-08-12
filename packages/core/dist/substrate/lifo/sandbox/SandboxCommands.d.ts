import type { Shell } from '../shell/Shell.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { Command } from '../commands/types.js';
import type { SandboxCommands as ISandboxCommands, RunOptions, CommandResult } from './types.js';
/**
 * Wraps Shell.execute() and serializes concurrent calls.
 * Concurrent commands.run() calls are queued (matches real shell behavior).
 */
export declare class SandboxCommandsImpl implements ISandboxCommands {
    private shell;
    readonly registry: CommandRegistry;
    private queue;
    constructor(shell: Shell, registry: CommandRegistry);
    run(cmd: string, options?: RunOptions): Promise<CommandResult>;
    register(name: string, handler: Command): void;
    private executeWithOptions;
}
//# sourceMappingURL=SandboxCommands.d.ts.map