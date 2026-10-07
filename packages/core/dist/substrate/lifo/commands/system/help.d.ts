import type { Command } from '../types.js';
import type { CommandRegistry } from '../registry.js';
/**
 * help: the shell's builtins, then each category's commands the registry
 * has, then the registered commands no category names. `builtinNames` is
 * the calling shell's (Shell.builtinNames).
 */
export declare function createHelpCommand(registry: CommandRegistry, builtinNames?: () => Iterable<string>): Command;
//# sourceMappingURL=help.d.ts.map