/**
 * builtins.ts — the commands a shell runs itself. Each acts on the state of
 * the shell that runs it (BuiltinExecutionContext.shell: the interactive
 * shell's, or a child shell's own after a fork), and reaches what only the
 * interactive shell has (its terminal, history, processes and commands)
 * through its BuiltinHost.
 */
import type { ProcessView } from '../../../runtime/process-files.js';
import { type CommandRegistry } from '../commands/registry.js';
import { type BuiltinFn } from './interpreter.js';
import type { ProcessRegistry } from './ProcessRegistry.js';
import { type HostProcessSignals } from '../commands/system/kill.js';
/** What a builtin reaches beyond the state of the shell running it: the interactive shell's own. */
export interface BuiltinHost {
    /** The interactive shell's view of the filesystem, as its identity has it now. */
    vfs(): ProcessView;
    readonly registry: CommandRegistry;
    readonly processRegistry: ProcessRegistry;
    /** The host's processes, which `kill` reaches by pid (Shell.setHostProcessSignals). */
    hostProcessSignals(): HostProcessSignals | undefined;
    clearTerminal(): void;
    history(): readonly string[];
}
/** The shell's builtins, by name, over `host`. */
export declare function shellBuiltins(host: BuiltinHost): Map<string, BuiltinFn>;
//# sourceMappingURL=builtins.d.ts.map