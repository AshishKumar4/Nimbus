import type { Shell } from '../shell/Shell.js';
import type { RunOptions, CommandResult } from './types.js';
/**
 * Run one command line on `shell` and collect its result. Whatever shell it is
 * given is the one the command acts on; it queues nothing, so two calls on two
 * shells run at once.
 */
export declare function runCommand(shell: Shell, cmd: string, options?: RunOptions): Promise<CommandResult>;
//# sourceMappingURL=SandboxCommands.d.ts.map