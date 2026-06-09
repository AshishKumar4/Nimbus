import type { VFS } from '../kernel/vfs/index.js';
import type { CommandOutputStream } from '../commands/types.js';
import type { BuiltinExecutionContext } from './interpreter.js';
import type { WordPart } from './types.js';
import { type ExpandContext } from './expander.js';
/**
 * Implementation of the `test` / `[` shell builtin.
 * Evaluates conditional expressions.
 */
export declare function evaluateTest(args: string[], vfs: VFS, stderr: CommandOutputStream, context?: BuiltinExecutionContext): number;
export declare function evaluateDoubleBracketWords(words: WordPart[][], expandCtx: ExpandContext, vfs: VFS, stderr: CommandOutputStream, context?: BuiltinExecutionContext): Promise<number>;
//# sourceMappingURL=test-builtin.d.ts.map