import type { VFS } from '../kernel/vfs/index.js';
import type { CommandOutputStream } from '../commands/types.js';
import type { BuiltinExecutionContext } from './interpreter.js';
/**
 * Implementation of the `test` / `[` shell builtin.
 * Evaluates conditional expressions.
 */
export declare function evaluateTest(args: string[], vfs: VFS, stderr: CommandOutputStream, context?: BuiltinExecutionContext): number;
//# sourceMappingURL=test-builtin.d.ts.map